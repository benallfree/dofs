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
use providers::sqlite::SqliteProvider;

fn main() {
    TermLogger::init(LevelFilter::Info, Config::default(), TerminalMode::Mixed, ColorChoice::Auto).unwrap();
    let args: Vec<String> = std::env::args().collect();
    let mut provider_name = "memory";
    for arg in &args {
        if let Some(rest) = arg.strip_prefix("--provider=") {
            provider_name = rest;
        }
    }
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

    let fs: FuseFS = match provider_name {
        "sqlite" => {
            println!("Using SQLite provider");
            let sqlite = SqliteProvider::new("cf-fuse.db").expect("Failed to open SQLite DB");
            FuseFS::new(Box::new(sqlite))
        },
        _ => {
            println!("Using memory provider");
            FuseFS::new(Box::new(MemoryProvider::new()))
        }
    };
    info!("Mounting FS at {} with provider {}", mountpoint, provider_name);
    fuser::mount2(fs, mountpoint, &[MountOption::FSName(format!("{}fs", provider_name)), MountOption::AutoUnmount]).unwrap();
}
