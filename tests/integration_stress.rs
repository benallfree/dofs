use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::thread::sleep;
use prettytable::{Table, row, cell};

const MOUNTPOINT: &str = "./mnt";
const TEST_FILE: &str = "./mnt/testfile";

struct ProviderTestResult {
    provider: &'static str,
    elapsed: Duration,
    success: bool,
    error: Option<String>,
}

struct StressTest {
    name: &'static str,
    func: fn() -> Result<(), String>,
}

fn run_fuse_with_provider(provider: &str) -> std::process::Child {
    Command::new("cargo")
        .args(["run", "--quiet", "--", "--provider", provider])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("Failed to start fuse process")
}

fn wait_for_mount() {
    for _ in 0..20 {
        if fs::metadata(MOUNTPOINT).is_ok() {
            return;
        }
        sleep(Duration::from_millis(100));
    }
    panic!("Mountpoint not available");
}

fn unmount() {
    let _ = Command::new("umount").arg(MOUNTPOINT).output();
}

fn clean_setup() {
    let _ = fs::remove_file("cf-fuse-simple.db");
    let _ = fs::remove_file("cf-fuse-chunked.db");
    let _ = fs::remove_dir_all(MOUNTPOINT);
    let _ = fs::create_dir_all(MOUNTPOINT);
}

fn file_create_write_read_delete() -> Result<(), String> {
    // Create file
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    // Write data
    let data = vec![42u8; 1024 * 1024];
    file.write_all(&data).map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Read data
    let mut file = File::open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    if buf != data {
        return Err("data mismatch".to_string());
    }
    // Remove file
    fs::remove_file(TEST_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

#[test]
fn integration_stress() {
    let providers = [
        ("memory", "MemoryProvider"),
        ("sqlite_simple", "SqliteSimpleProvider"),
        ("sqlite_chunked", "SqliteChunkedProvider"),
    ];
    let stress_tests = [
        StressTest { name: "file_create_write_read_delete", func: file_create_write_read_delete },
        // Add more tests here
    ];
    let mut results = vec![];
    for test in &stress_tests {
        let mut row = vec![];
        for (prov, prov_name) in providers.iter() {
            clean_setup();
            let mut child = run_fuse_with_provider(prov);
            wait_for_mount();
            let start = Instant::now();
            let (success, error) = match (test.func)() {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e)),
            };
            let elapsed = start.elapsed();
            unmount();
            let _ = child.kill();
            row.push(ProviderTestResult {
                provider: prov_name,
                elapsed,
                success,
                error,
            });
        }
        results.push((test.name, row));
    }
    // Print summary table
    let mut table = Table::new();
    let mut header = vec!["operation".to_string()];
    for (_, prov_name) in providers.iter() {
        header.push(prov_name.to_string());
    }
    table.add_row(row![header[0], header[1], header[2], header[3]]);
    for (test_name, row) in &results {
        table.add_row(row![
            *test_name,
            row.get(0).map(|r| r.elapsed.as_micros().to_string()).unwrap_or("-".to_string()),
            row.get(1).map(|r| r.elapsed.as_micros().to_string()).unwrap_or("-".to_string()),
            row.get(2).map(|r| r.elapsed.as_micros().to_string()).unwrap_or("-".to_string()),
        ]);
    }
    table.printstd();
    assert!(results.iter().all(|(_, row)| row.iter().all(|r| r.success)), "Some providers failed");
} 