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
use providers::sqlite_simple::SqliteProvider as SqliteSimpleProvider;
use providers::sqlite_chunked::SqliteChunkedProvider;
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Mount the filesystem
    Mount {
        #[arg(long, default_value = "memory")]
        provider: String,
        #[arg(long, default_value_t = false)]
        mode_osx: bool,
        #[arg(long, default_value_t = 4096)]
        chunk_size: usize,
        #[arg(long, default_value = "./mnt")]
        mountpoint: String,
        #[arg(long, default_value = "")]
        db_path: String,
    },
    /// List available providers
    ListProviders,
    /// Show filesystem stats
    Stats {
        #[arg(long, default_value = "")]
        db_path: String,
    },
}

fn main() {
    TermLogger::init(LevelFilter::Info, Config::default(), TerminalMode::Mixed, ColorChoice::Auto).unwrap();
    let cli = Cli::parse();

    match cli.command {
        Commands::Mount { provider, mode_osx, chunk_size, mountpoint, db_path } => {
            let provider_name = provider.as_str();
            let osx_mode = mode_osx;
            let mountpoint = mountpoint.as_str();
            let db_path = if db_path.is_empty() {
                None
            } else {
                Some(db_path.as_str())
            };
            if std::path::Path::new(mountpoint).exists() {
                // Try to unmount in case it was left mounted from a previous panic
                let _ = Command::new("umount").arg(mountpoint).status();
            }
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
                "sqlite_simple" => {
                    println!("Using SQLite Simple provider");
                    let db_file = db_path.unwrap_or("cf-fuse-simple.db");
                    let sqlite = SqliteSimpleProvider::new_with_mode(db_file, osx_mode).expect("Failed to open SQLite DB");
                    FuseFS::new(Box::new(sqlite))
                },
                "sqlite_chunked" => {
                    println!("Using SQLite Chunked provider");
                    let db_file = db_path.unwrap_or("cf-fuse-chunked.db");
                    let sqlite = SqliteChunkedProvider::new_with_mode(db_file, osx_mode, chunk_size).expect("Failed to open SQLite DB");
                    FuseFS::new(Box::new(sqlite))
                },
                _ => {
                    println!("Using memory provider");
                    FuseFS::new(Box::new(MemoryProvider::new_with_mode(osx_mode)))
                }
            };
            info!("Mounting FS at {} with provider {}", mountpoint, provider_name);
            fuser::mount2(fs, mountpoint, &[MountOption::FSName(format!("{}fs", provider_name)), MountOption::AutoUnmount]).unwrap();
        },
        Commands::ListProviders => {
            println!("Available providers:");
            println!("  memory         - In-memory storage (default)");
            println!("  sqlite_simple  - Simple SQLite storage");
            println!("  sqlite_chunked - Chunked SQLite storage");
        },
        Commands::Stats { db_path } => {
            if db_path.is_empty() {
                println!("Please specify a database path with --db-path");
                return;
            }
            println!("Stats for database: {}", db_path);
            // TODO: Implement stats command
        },
    }
}
