use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::fs::{self, File, create_dir, read_dir, remove_dir, OpenOptions};
use std::io::{Read, Write};
use std::thread::sleep;
use prettytable::{Table, row, cell, Row, Cell};

const MOUNTPOINT: &str = "./mnt";
const TEST_FILE: &str = "./mnt/testfile";
const TEST_DIR: &str = "./mnt/testdir";

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
    for _ in 0..40 {
        if std::fs::metadata(format!("{}/.fuse_ready", MOUNTPOINT)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("Mountpoint not available or .fuse_ready not present");
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

fn dir_create_list_delete() -> Result<(), String> {
    // Create directory
    create_dir(TEST_DIR).map_err(|e| format!("create_dir: {e}"))?;
    // List directory
    let entries: Vec<_> = read_dir("./mnt").map_err(|e| format!("read_dir: {e}"))?.collect();
    if !entries.iter().filter_map(|e| e.as_ref().ok()).any(|e| e.file_name() == "testdir") {
        return Err("directory not found in listing".to_string());
    }
    // Remove directory
    remove_dir(TEST_DIR).map_err(|e| format!("remove_dir: {e}"))?;
    Ok(())
}

fn file_append_read_delete() -> Result<(), String> {
    // Create file and write initial data
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    let data1 = vec![1u8; 512 * 1024];
    file.write_all(&data1).map_err(|e| format!("write1: {e}"))?;
    drop(file);
    // Append data
    let mut file = OpenOptions::new().append(true).open(TEST_FILE).map_err(|e| format!("open append: {e}"))?;
    let data2 = vec![2u8; 512 * 1024];
    file.write_all(&data2).map_err(|e| format!("write2: {e}"))?;
    drop(file);
    // Read back and check
    let mut file = File::open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    if buf.len() != 1024 * 1024 || &buf[..512*1024] != &data1[..] || &buf[512*1024..] != &data2[..] {
        return Err("data mismatch after append".to_string());
    }
    // Remove file
    fs::remove_file(TEST_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

fn file_truncate_shrink_read_delete() -> Result<(), String> {
    use std::fs::OpenOptions;
    // Create file and write data
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    let data = vec![7u8; 1024 * 1024];
    file.write_all(&data).map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Truncate to half
    let mut file = OpenOptions::new().write(true).open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    file.set_len(512 * 1024).map_err(|e| format!("truncate: {e}"))?;
    drop(file);
    // Read back and check
    let mut file = File::open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    if buf.len() != 512 * 1024 || !buf.iter().all(|&b| b == 7) {
        return Err("data mismatch after truncate".to_string());
    }
    // Remove file
    fs::remove_file(TEST_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

fn file_truncate_grow_read_delete() -> Result<(), String> {
    use std::fs::OpenOptions;
    // Create file and write small data
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    let data = vec![9u8; 512 * 1024];
    file.write_all(&data).map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Grow file to 1MB
    let file = OpenOptions::new().write(true).open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    file.set_len(1024 * 1024).map_err(|e| format!("truncate: {e}"))?;
    drop(file);
    // Read back and check
    let mut file = File::open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    if buf.len() != 1024 * 1024 || &buf[..512*1024] != &data[..] || !buf[512*1024..].iter().all(|&b| b == 0) {
        return Err("data mismatch after grow".to_string());
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
        StressTest { name: "dir_create_list_delete", func: dir_create_list_delete },
        StressTest { name: "file_append_read_delete", func: file_append_read_delete },
        StressTest { name: "file_truncate_shrink_read_delete", func: file_truncate_shrink_read_delete },
        StressTest { name: "file_truncate_grow_read_delete", func: file_truncate_grow_read_delete },
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
    table.add_row(Row::new(header.iter().map(|s| Cell::new(s)).collect()));
    for (test_name, row) in &results {
        let mut cells = vec![test_name.to_string()];
        for r in row {
            cells.push(r.elapsed.as_micros().to_string());
        }
        table.add_row(Row::new(cells.iter().map(|s| Cell::new(s)).collect()));
    }
    table.printstd();
    assert!(results.iter().all(|(_, row)| row.iter().all(|r| r.success)), "Some providers failed");
} 