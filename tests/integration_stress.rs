use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::fs::{self, File, create_dir, read_dir, remove_dir, OpenOptions, rename, remove_file, metadata};
use std::io::{Read, Write};
use std::io::Seek;
use prettytable::{Table, Row, Cell};
use libc;
use std::os::unix::fs::symlink;
use rand::{Rng, SeedableRng};
use std::sync::{Arc, Barrier};
use std::thread;

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

fn concurrent_file_access() -> Result<(), String> {
    let num_threads = 8;
    let iterations = 1000;
    let barrier = Arc::new(Barrier::new(num_threads));
    // Create file
    let mut file = File::create(TEST_FILE).map_err(|e| format!("create: {e}"))?;
    file.write_all(&[0u8; 4096]).map_err(|e| format!("init write: {e}"))?;
    drop(file);
    let mut handles = vec![];
    for tid in 0..num_threads {
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            for i in 0..iterations {
                let mut file = OpenOptions::new().read(true).write(true).open(TEST_FILE).map_err(|e| format!("open: {e}"))?;
                let pos = ((tid * 512 + i) % 4096) as u64;
                file.seek(std::io::SeekFrom::Start(pos)).map_err(|e| format!("seek: {e}"))?;
                let val = (tid as u8) ^ (i as u8);
                file.write_all(&[val]).map_err(|e| format!("write: {e}"))?;
            }
            Ok::<(), String>(())
        }));
    }
    for h in handles {
        h.join().map_err(|_| "thread panic".to_string())??;
    }
    fs::remove_file(TEST_FILE).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

fn dir_rename_check_delete() -> Result<(), String> {
    const DIR1: &str = "./mnt/testdir1";
    const DIR2: &str = "./mnt/testdir2";
    const FILE_IN_DIR: &str = "./mnt/testdir1/file";
    // Create directory and file inside
    create_dir(DIR1).map_err(|e| format!("create_dir: {e}"))?;
    let mut file = File::create(FILE_IN_DIR).map_err(|e| format!("create file: {e}"))?;
    file.write_all(b"dir rename test").map_err(|e| format!("write: {e}"))?;
    drop(file);
    // Rename directory
    rename(DIR1, DIR2).map_err(|e| format!("rename dir: {e}"))?;
    // Check file is accessible at new path
    let mut file = File::open("./mnt/testdir2/file").map_err(|e| format!("open after rename: {e}"))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).map_err(|e| format!("read: {e}"))?;
    if buf != "dir rename test" {
        return Err("file content mismatch after dir rename".to_string());
    }
    // Remove file and directory
    fs::remove_file("./mnt/testdir2/file").map_err(|e| format!("remove file: {e}"))?;
    remove_dir(DIR2).map_err(|e| format!("remove dir: {e}"))?;
    Ok(())
}

fn nested_dir_create_write_read_recursive_delete() -> Result<(), String> {
    let dir1 = "./mnt/dir1";
    let dir2 = "./mnt/dir1/dir2";
    let dir3 = "./mnt/dir1/dir2/dir3";
    let file1 = format!("{}/file1", dir1);
    let file2 = format!("{}/file2", dir2);
    let file3 = format!("{}/file3", dir3);
    // Create nested directories
    fs::create_dir_all(&dir3).map_err(|e| format!("create_dir_all: {e}"))?;
    // Create files at each level
    let mut f1 = File::create(&file1).map_err(|e| format!("create file1: {e}"))?;
    let mut f2 = File::create(&file2).map_err(|e| format!("create file2: {e}"))?;
    let mut f3 = File::create(&file3).map_err(|e| format!("create file3: {e}"))?;
    f1.write_all(b"file1 data").map_err(|e| format!("write file1: {e}"))?;
    f2.write_all(b"file2 data").map_err(|e| format!("write file2: {e}"))?;
    f3.write_all(b"file3 data").map_err(|e| format!("write file3: {e}"))?;
    drop((f1, f2, f3));
    // Read back and check
    let mut buf = String::new();
    File::open(&file1).map_err(|e| format!("open file1: {e}"))?.read_to_string(&mut buf).map_err(|e| format!("read file1: {e}"))?;
    if buf != "file1 data" { return Err("file1 content mismatch".to_string()); }
    buf.clear();
    File::open(&file2).map_err(|e| format!("open file2: {e}"))?.read_to_string(&mut buf).map_err(|e| format!("read file2: {e}"))?;
    if buf != "file2 data" { return Err("file2 content mismatch".to_string()); }
    buf.clear();
    File::open(&file3).map_err(|e| format!("open file3: {e}"))?.read_to_string(&mut buf).map_err(|e| format!("read file3: {e}"))?;
    if buf != "file3 data" { return Err("file3 content mismatch".to_string()); }
    // Recursively delete top-level directory
    fs::remove_dir_all(dir1).map_err(|e| format!("remove_dir_all: {e}"))?;
    // Verify all gone
    if fs::metadata(dir1).is_ok() || fs::metadata(dir2).is_ok() || fs::metadata(dir3).is_ok() {
        return Err("directories not fully deleted".to_string());
    }
    if fs::metadata(&file1).is_ok() || fs::metadata(&file2).is_ok() || fs::metadata(&file3).is_ok() {
        return Err("files not fully deleted".to_string());
    }
    Ok(())
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
        StressTest { name: "concurrent_file_access", func: concurrent_file_access, skip_providers: None },
        StressTest { name: "dir_rename_check_delete", func: dir_rename_check_delete, skip_providers: None },
        StressTest { name: "nested_dir_create_write_read_recursive_delete", func: nested_dir_create_write_read_recursive_delete, skip_providers: None },
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