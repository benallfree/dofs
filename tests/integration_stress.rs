use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::fs::{self, File, create_dir, read_dir, remove_dir, OpenOptions, rename, remove_file, metadata};
use std::io::{Read, Write};
use std::io::Seek;
use prettytable::{Table, Row, Cell};
use libc;
use std::os::unix::fs::symlink;
use rand::{Rng, SeedableRng};

const MOUNTPOINT: &str = "./mnt";
const TEST_FILE: &str = "./mnt/testfile";
const TEST_DIR: &str = "./mnt/testdir";

#[derive(Clone)]
struct ProviderTestResult {
    elapsed: Duration,
    success: bool,
    error: Option<String>,
}

struct StressTest {
    name: &'static str,
    func: fn() -> Result<(), String>,
    skip_providers: Option<&'static [&'static str]>,
}

fn run_fuse_with_provider(provider: &str, db_path: Option<&str>) -> std::process::Child {
    let mut cmd = Command::new("cargo");
    cmd.args(["run", "--quiet", "--", "--mode-osx", "--provider", provider]);
    if let Some(path) = db_path {
        cmd.args(["--db-path", path]);
    }
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("Failed to start fuse process")
}

fn wait_for_mount() {
    for _ in 0..40 {
        if let Ok(mut file) = File::open(format!("{}/.fuse_ready", MOUNTPOINT)) {
            let mut contents = String::new();
            if file.read_to_string(&mut contents).is_ok() {
                println!("Found .fuse_ready with contents: {}", contents);
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("Mountpoint not available or .fuse_ready not present");
}

fn wait_for_unmount() {
    for _ in 0..40 {
        if std::fs::metadata(format!("{}/.fuse_ready", MOUNTPOINT)).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("Mountpoint still present or .fuse_ready still exists");
}

fn clean_setup(db_path: Option<&str>) {
    let _ = fs::remove_file("cf-fuse-simple.db");
    let _ = fs::remove_file("cf-fuse-chunked.db");
    if let Some(path) = db_path {
        let _ = fs::remove_file(path);
    }
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
    let file = OpenOptions::new().write(true).open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
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

fn file_rename_check_delete() -> Result<(), String> {
    const RENAMED_FILE: &str = "./mnt/testfile_renamed";
    // Create file
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    file.write_all(b"hello").map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Rename file
    rename(TEST_FILE, RENAMED_FILE).map_err(|e| format!("rename: {e}"))?;
    // Check new name exists
    metadata(RENAMED_FILE).map_err(|e| format!("metadata: {e}"))?;
    // Remove file
    remove_file(RENAMED_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

fn symlink_create_read_delete() -> Result<(), String> {
    const SYMLINK_PATH: &str = "./mnt/testfile_symlink";
    // Create file to point to
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    file.write_all(b"symlink target").map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Create symlink
    symlink(TEST_FILE, SYMLINK_PATH).map_err(|e| format!("symlink: {e}"))?;
    // Read symlink
    let target = fs::read_link(SYMLINK_PATH).map_err(|e| format!("read_link: {e}"))?;
    if target != std::path::Path::new(TEST_FILE) {
        return Err("symlink target mismatch".to_string());
    }
    // Remove symlink
    fs::remove_file(SYMLINK_PATH).map_err(|e| format!("remove symlink: {e}"))?;
    // Remove target file
    fs::remove_file(TEST_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

fn file_create_write_read_delete_size(size: usize) -> Result<(), String> {
    // Create file
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    // Write data of given size
    let data = vec![55u8; size];
    file.write_all(&data).map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Read data
    let mut file = File::open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    if buf != data {
        return Err("data mismatch".to_string());
    }
    drop(file);
    // Random access write: overwrite 10 random positions with unique values
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(TEST_FILE).map_err(|e| format!("open for random write: {e}"))?;
    let mut random_indices = vec![];
    for i in 0..10 {
        let idx = rng.gen_range(0..size);
        random_indices.push(idx);
        file.seek(std::io::SeekFrom::Start(idx as u64)).map_err(|e| format!("seek: {e}"))?;
        file.write_all(&[i as u8]).map_err(|e| format!("random write: {e}"))?;
    }
    drop(file);
    // Random access read: verify the 10 random positions
    let mut file = std::fs::OpenOptions::new().read(true).open(TEST_FILE).map_err(|e| format!("open for random read: {e}"))?;
    for (i, &idx) in random_indices.iter().enumerate() {
        file.seek(std::io::SeekFrom::Start(idx as u64)).map_err(|e| format!("seek: {e}"))?;
        let mut b = [0u8; 1];
        file.read_exact(&mut b).map_err(|e| format!("random read: {e}"))?;
        if b[0] != i as u8 {
            return Err(format!("random access data mismatch at {idx}: expected {} got {}", i as u8, b[0]));
        }
    }
    drop(file);
    // Remove file
    fs::remove_file(TEST_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

fn file_create_write_read_delete_large() -> Result<(), String> {
    // 100MB
    file_create_write_read_delete_size(100 * 1024 * 1024)
}

#[test]
fn integration_stress() {
    let providers = [
        ("memory", "MemoryProvider", None),
        ("sqlite_simple", "SqliteSimpleProvider", Some("test-sqlite-simple.db")),
        ("sqlite_chunked", "SqliteChunkedProvider", Some("test-sqlite-chunked.db")),
    ];
    let stress_tests = [
        StressTest { name: "file_create_write_read_delete", func: file_create_write_read_delete, skip_providers: None },
        StressTest { name: "file_create_write_read_delete_large", func: file_create_write_read_delete_large, skip_providers: Some(&["sqlite_simple"]) },
        StressTest { name: "dir_create_list_delete", func: dir_create_list_delete, skip_providers: None },
        StressTest { name: "file_append_read_delete", func: file_append_read_delete, skip_providers: None },
        StressTest { name: "file_truncate_shrink_read_delete", func: file_truncate_shrink_read_delete, skip_providers: None },
        StressTest { name: "file_truncate_grow_read_delete", func: file_truncate_grow_read_delete, skip_providers: None },
        StressTest { name: "file_rename_check_delete", func: file_rename_check_delete, skip_providers: None },
        StressTest { name: "symlink_create_read_delete", func: symlink_create_read_delete, skip_providers: None },
        // Add more tests here
    ];
    let mut results = vec![vec![]; stress_tests.len()];
    for (prov_idx, (prov, prov_name, db_path)) in providers.iter().enumerate() {
        clean_setup(*db_path);
        let mut child = run_fuse_with_provider(prov, *db_path);
        wait_for_mount();
        for (test_idx, test) in stress_tests.iter().enumerate() {
            // Skip test for this provider if listed
            if let Some(skips) = test.skip_providers {
                if skips.iter().any(|&s| s == providers[prov_idx].0) {
                    results[test_idx].push(ProviderTestResult {
                        elapsed: Duration::from_micros(0),
                        success: true,
                        error: None,
                    });
                    continue;
                }
            }
            println!("running test: {} with provider: {}", test.name, prov_name);
            let start = Instant::now();
            let (success, error) = match (test.func)() {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e)),
            };
            let elapsed = start.elapsed();
            results[test_idx].push(ProviderTestResult {
                elapsed,
                success,
                error,
            });
        }
        unsafe {
            libc::kill(child.id() as i32, libc::SIGINT);
        }
        let _ = child.wait();
        wait_for_unmount();
    }
    // Print summary table
    let mut table = Table::new();
    let mut header = vec!["operation".to_string()];
    for (_, prov_name, _) in providers.iter() {
        header.push(format!("{} (μs)", prov_name));
    }
    table.add_row(Row::new(header.iter().map(|s| Cell::new(s)).collect()));
    for (test_idx, test) in stress_tests.iter().enumerate() {
        let mut cells = vec![test.name.to_string()];
        // Collect all elapsed times for this test row (only successful and not skipped ones)
        let times: Vec<Option<u128>> = results[test_idx]
            .iter()
            .enumerate()
            .map(|(prov_idx, r)| {
                // Check if this test was skipped for this provider
                if let Some(skips) = test.skip_providers {
                    if skips.iter().any(|&s| s == providers[prov_idx].0) {
                        return None;
                    }
                }
                if r.success {
                    Some(r.elapsed.as_micros())
                } else {
                    None
                }
            })
            .collect();
        // Find the minimum time (ignore failures and skips)
        let min_time = times.iter().filter_map(|&t| t).min().unwrap_or(0);
        for (prov_idx, (_, _prov_name, _)) in providers.iter().enumerate() {
            // Check if this test was skipped for this provider
            if let Some(skips) = test.skip_providers {
                if skips.iter().any(|&s| s == providers[prov_idx].0) {
                    cells.push("(skipped)".to_string());
                    continue;
                }
            }
            let r = &results[test_idx][prov_idx];
            if r.success {
                let t = r.elapsed.as_micros();
                if t == min_time && min_time > 0 {
                    cells.push(format!("{}", t));
                } else if min_time > 0 {
                    let percent = ((t as f64 - min_time as f64) / min_time as f64 * 100.0).round() as i64;
                    cells.push(format!("{} (+{}%)", t, percent));
                } else {
                    cells.push(format!("{}", t));
                }
            } else {
                cells.push("\u{274C}".to_string());
            }
        }
        table.add_row(Row::new(cells.iter().map(|s| Cell::new(s)).collect()));
    }
    table.printstd();

    // Print failure details table
    let mut failure_table = Table::new();
    failure_table.add_row(Row::new(vec![Cell::new("test"), Cell::new("provider"), Cell::new("reason")]));
    for (test_idx, test) in stress_tests.iter().enumerate() {
        for (_prov_idx, (_, _prov_name, _)) in providers.iter().enumerate() {
            let r = &results[test_idx][_prov_idx];
            if !r.success {
                failure_table.add_row(Row::new(vec![
                    Cell::new(test.name),
                    Cell::new(_prov_name),
                    Cell::new(r.error.as_deref().unwrap_or("unknown error")),
                ]));
            }
        }
    }
    if failure_table.len() > 1 {
        println!("\nFailure details:");
        failure_table.printstd();
    }
    assert!(results.iter().enumerate().all(|(test_idx, row)| {
        row.iter().enumerate().all(|(prov_idx, r)| {
            // If test is skipped for this provider, treat as success
            if let Some(skips) = stress_tests[test_idx].skip_providers {
                if skips.iter().any(|&s| s == providers[prov_idx].0) {
                    return true;
                }
            }
            r.success
        })
    }), "Some providers failed");

    // Final cleanup: remove test DBs if present
    let _ = std::fs::remove_file("test-sqlite-simple.db");
    let _ = std::fs::remove_file("test-sqlite-chunked.db");
} 