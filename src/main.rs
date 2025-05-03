use fuser::{MountOption};
use ctrlc;
use std::process::Command;
use std::fs;
use log::info;
use simplelog::*;
mod fusefs;
mod providers;
use fusefs::FuseFS;
use providers::memory::MemoryProvider;

fn main() {
    TermLogger::init(LevelFilter::Info, Config::default(), TerminalMode::Mixed, ColorChoice::Auto).unwrap();
    let mountpoint = "./mnt";
    if !std::path::Path::new(mountpoint).exists() {
        fs::create_dir_all(mountpoint).expect("Failed to create mountpoint");
    }

    // Setup Ctrl+C handler to unmount
    let mountpoint_string = mountpoint.to_string();
    ctrlc::set_handler(move || {
        eprintln!("\nReceived Ctrl+C, unmounting {}...", mountpoint_string);
        let status = Command::new("umount").arg(&mountpoint_string).status();
        match status {
            Ok(s) if s.success() => {
                eprintln!("Successfully unmounted {}", mountpoint_string);
            }
            Ok(s) => {
                eprintln!("umount exited with status: {}", s);
            }
            Err(e) => {
                eprintln!("Failed to run umount: {}", e);
            }
        }
        std::process::exit(0);
    }).expect("Error setting Ctrl+C handler");

    let fs = FuseFS::new(Box::new(MemoryProvider::new()));
    info!("Mounting MemFS at {}", mountpoint);
    fuser::mount2(fs, mountpoint, &[MountOption::FSName("memfs".to_string()), MountOption::AutoUnmount]).unwrap();
}
