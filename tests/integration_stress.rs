use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::thread::sleep;
use prettytable::{Table, row, cell};

const MOUNTPOINT: &str = "./mnt";
const TEST_FILE: &str = "./mnt/testfile";

struct ProviderTestResult {
    name: &'static str,
    elapsed: Duration,
    success: bool,
    error: Option<String>,
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

fn stress_test() -> Result<(), String> {
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
    let mut results = Vec::new();
    for (prov, name) in providers.iter() {
        // Clean up before test
        let _ = fs::remove_file("cf-fuse-simple.db");
        let _ = fs::remove_file("cf-fuse-chunked.db");
        let _ = fs::remove_dir_all(MOUNTPOINT);
        let _ = fs::create_dir_all(MOUNTPOINT);
        let mut child = run_fuse_with_provider(prov);
        wait_for_mount();
        let start = Instant::now();
        let (success, error) = match stress_test() {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e)),
        };
        let elapsed = start.elapsed();
        unmount();
        let _ = child.kill();
        results.push(ProviderTestResult {
            name,
            elapsed,
            success,
            error,
        });
    }
    // Print summary table
    let mut table = Table::new();
    table.add_row(row!["Provider", "Success", "Time (ms)", "Error"]);
    for r in &results {
        table.add_row(row![
            r.name,
            if r.success { "yes" } else { "no" },
            r.elapsed.as_millis().to_string(),
            r.error.as_deref().unwrap_or("")
        ]);
    }
    table.printstd();
    assert!(results.iter().all(|r| r.success), "Some providers failed");
} 