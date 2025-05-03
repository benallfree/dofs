use fuser::{Filesystem, Request, ReplyAttr, ReplyEntry, ReplyDirectory, ReplyData, ReplyCreate, ReplyWrite, MountOption};
use ctrlc;
use std::process::Command;
use libc::ENOENT;
use std::collections::{HashMap, BTreeMap};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::fs;
use log::info;
use simplelog::*;

const TTL: Duration = Duration::from_secs(1); // 1 second
const ROOT_INODE: u64 = 1;

#[derive(Debug, Clone)]
struct InMemoryFile {
    name: String,
    data: Vec<u8>,
    attr: fuser::FileAttr,
}

#[derive(Debug, Clone)]
struct InMemoryDir {
    name: String,
    children: BTreeMap<String, u64>, // name -> inode
    attr: fuser::FileAttr,
}

#[derive(Debug)]
struct MemFS {
    inodes: HashMap<u64, Node>,
    paths: HashMap<PathBuf, u64>,
    next_inode: u64,
}

#[derive(Debug, Clone)]
enum Node {
    File(InMemoryFile),
    Dir(InMemoryDir),
}

impl MemFS {
    fn new() -> Self {
        let mut inodes = HashMap::new();
        let mut paths = HashMap::new();
        let root_attr = fuser::FileAttr {
            ino: ROOT_INODE,
            size: 0,
            blocks: 0,
            atime: UNIX_EPOCH,
            mtime: UNIX_EPOCH,
            ctime: UNIX_EPOCH,
            crtime: UNIX_EPOCH,
            kind: fuser::FileType::Directory,
            perm: 0o755,
            nlink: 2,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            rdev: 0,
            flags: 0,
            blksize: 512,
        };
        let root = Node::Dir(InMemoryDir {
            name: "/".to_string(),
            children: BTreeMap::new(),
            attr: root_attr,
        });
        inodes.insert(ROOT_INODE, root);
        paths.insert(PathBuf::from("/"), ROOT_INODE);
        Self { inodes, paths, next_inode: ROOT_INODE + 1 }
    }

    fn alloc_inode(&mut self) -> u64 {
        let ino = self.next_inode;
        self.next_inode += 1;
        ino
    }
}

impl Filesystem for MemFS {
    // Return ENOSYS for all unimplemented methods
    fn rename(&mut self, _req: &Request<'_>, _parent: u64, _name: &OsStr, _newparent: u64, _newname: &OsStr, _flags: u32, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn link(&mut self, _req: &Request<'_>, _ino: u64, _newparent: u64, _newname: &OsStr, reply: fuser::ReplyEntry) {
        reply.error(libc::ENOSYS);
    }
    fn unlink(&mut self, _req: &Request<'_>, _parent: u64, _name: &OsStr, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn mknod(&mut self, _req: &Request<'_>, _parent: u64, _name: &OsStr, _mode: u32, _rdev: u32, _flags: u32, reply: fuser::ReplyEntry) {
        reply.error(libc::ENOSYS);
    }
    fn symlink(&mut self, _req: &Request<'_>, _parent: u64, _name: &OsStr, _link: &std::path::Path, reply: fuser::ReplyEntry) {
        reply.error(libc::ENOSYS);
    }
    fn readlink(&mut self, _req: &Request<'_>, _ino: u64, reply: fuser::ReplyData) {
        reply.error(libc::ENOSYS);
    }
    fn fsync(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _datasync: bool, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn fallocate(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _offset: i64, _length: i64, _mode: i32, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn statfs(&mut self, _req: &Request<'_>, _ino: u64, reply: fuser::ReplyStatfs) {
        reply.error(libc::ENOSYS);
    }
    fn opendir(&mut self, _req: &Request<'_>, _ino: u64, _flags: i32, reply: fuser::ReplyOpen) {
        reply.error(libc::ENOSYS);
    }
    fn releasedir(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _flags: i32, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn fsyncdir(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _datasync: bool, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn getxattr(&mut self, _req: &Request<'_>, _ino: u64, _name: &OsStr, _size: u32, reply: fuser::ReplyXattr) {
        reply.error(libc::ENOSYS);
    }
    fn setxattr(&mut self, _req: &Request<'_>, _ino: u64, _name: &OsStr, _value: &[u8], _flags: i32, _position: u32, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn listxattr(&mut self, _req: &Request<'_>, _ino: u64, _size: u32, reply: fuser::ReplyXattr) {
        reply.error(libc::ENOSYS);
    }
    fn removexattr(&mut self, _req: &Request<'_>, _ino: u64, _name: &OsStr, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn access(&mut self, _req: &Request<'_>, _ino: u64, _mask: i32, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn bmap(&mut self, _req: &Request<'_>, _ino: u64, _blocksize: u32, _idx: u64, reply: fuser::ReplyBmap) {
        reply.error(libc::ENOSYS);
    }
    fn ioctl(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _flags: u32, _cmd: u32, _in_data: &[u8], _out_size: u32, reply: fuser::ReplyIoctl) {
        reply.error(libc::ENOSYS);
    }

    fn copy_file_range(&mut self, _req: &Request<'_>, _ino_in: u64, _fh_in: u64, _offset_in: i64, _ino_out: u64, _fh_out: u64, _offset_out: i64, _len: u64, _flags: u32, reply: fuser::ReplyWrite) {
        reply.error(libc::ENOSYS);
    }
    fn lseek(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _offset: i64, _whence: i32, reply: fuser::ReplyLseek) {
        reply.error(libc::ENOSYS);
    }
    fn destroy(&mut self) {
        // No-op
    }
    fn init(&mut self, _req: &Request<'_>, _config: &mut fuser::KernelConfig) -> Result<(), i32> {
        Ok(())
    }
    fn forget(&mut self, _req: &Request<'_>, _ino: u64, _nlookup: u64) {
        // No-op
    }
    fn getlk(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _lock_owner: u64, _start: u64, _end: u64, _typ: i32, _pid: u32, reply: fuser::ReplyLock) {
        reply.error(libc::ENOSYS);
    }
    fn setlk(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _lock_owner: u64, _start: u64, _end: u64, _typ: i32, _pid: u32, _sleep: bool, reply: fuser::ReplyEmpty) {
        reply.error(libc::ENOSYS);
    }
    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &std::ffi::OsStr, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        // Find parent directory
        let target_ino = if let Some(Node::Dir(parent_dir)) = self.inodes.get(&parent) {
            parent_dir.children.get(name_str).copied()
        } else {
            reply.error(libc::ENOENT); // Parent not found
            return;
        };
        let ino = match target_ino {
            Some(ino) => ino,
            None => {
                reply.error(libc::ENOENT); // Entry not found
                return;
            }
        };
        // Check if the inode is a directory and is empty
        let is_empty_dir = if let Some(Node::Dir(dir)) = self.inodes.get(&ino) {
            dir.children.is_empty()
        } else {
            reply.error(libc::ENOTDIR); // Not a directory
            return;
        };
        if !is_empty_dir {
            reply.error(libc::ENOTEMPTY); // Directory not empty
            return;
        }
        // Now remove from parent's children and from inode map
        if let Some(Node::Dir(parent_dir)) = self.inodes.get_mut(&parent) {
            parent_dir.children.remove(name_str);
        }
        self.inodes.remove(&ino);
        reply.ok();
    }
    fn open(&mut self, _req: &Request<'_>, ino: u64, _flags: i32, reply: fuser::ReplyOpen) {
        if self.inodes.contains_key(&ino) {
            reply.opened(0, 0);
        } else {
            reply.error(ENOENT);
        }
    }

    fn flush(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, _lock_owner: u64, reply: fuser::ReplyEmpty) {
        if self.inodes.contains_key(&ino) {
            reply.ok();
        } else {
            reply.error(ENOENT);
        }
    }

    fn release(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, _flags: i32, _lock_owner: Option<u64>, _flush: bool, reply: fuser::ReplyEmpty) {
        if self.inodes.contains_key(&ino) {
            reply.ok();
        } else {
            reply.error(ENOENT);
        }
    }

    fn setattr(&mut self, _req: &Request<'_>, ino: u64, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, atime: Option<fuser::TimeOrNow>, mtime: Option<fuser::TimeOrNow>, ctime: Option<std::time::SystemTime>, fh: Option<u64>, crtime: Option<std::time::SystemTime>, chgtime: Option<std::time::SystemTime>, bkuptime: Option<std::time::SystemTime>, flags: Option<u32>, reply: ReplyAttr) {
        fn timeornow_to_systemtime(t: fuser::TimeOrNow) -> std::time::SystemTime {
            match t {
                fuser::TimeOrNow::SpecificTime(st) => st,
                fuser::TimeOrNow::Now => std::time::SystemTime::now(),
            }
        }
        if let Some(node) = self.inodes.get_mut(&ino) {
            match node {
                Node::File(f) => {
                    if let Some(new_size) = size {
                        f.data.resize(new_size as usize, 0);
                        f.attr.size = new_size;
                    }
                    if let Some(m) = mode { f.attr.perm = m as u16; }
                    if let Some(u) = uid { f.attr.uid = u; }
                    if let Some(g) = gid { f.attr.gid = g; }
                    if let Some(a) = atime { f.attr.atime = timeornow_to_systemtime(a); }
                    if let Some(m) = mtime { f.attr.mtime = timeornow_to_systemtime(m); }
                    if let Some(c) = ctime { f.attr.ctime = c; }
                    if let Some(cr) = crtime { f.attr.crtime = cr; }
                    if let Some(fg) = flags { f.attr.flags = fg; }
                    reply.attr(&TTL, &f.attr);
                }
                Node::Dir(d) => {
                    if let Some(m) = mode { d.attr.perm = m as u16; }
                    if let Some(u) = uid { d.attr.uid = u; }
                    if let Some(g) = gid { d.attr.gid = g; }
                    if let Some(a) = atime { d.attr.atime = timeornow_to_systemtime(a); }
                    if let Some(m) = mtime { d.attr.mtime = timeornow_to_systemtime(m); }
                    if let Some(c) = ctime { d.attr.ctime = c; }
                    if let Some(cr) = crtime { d.attr.crtime = cr; }
                    if let Some(fg) = flags { d.attr.flags = fg; }
                    reply.attr(&TTL, &d.attr);
                }
            }
        } else {
            reply.error(ENOENT);
        }
    }
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let name = name.to_str().unwrap_or("");
        let parent_node = self.inodes.get(&parent);
        if let Some(Node::Dir(dir)) = parent_node {
            if let Some(&child_ino) = dir.children.get(name) {
                if let Some(node) = self.inodes.get(&child_ino) {
                    let attr = match node {
                        Node::File(f) => f.attr,
                        Node::Dir(d) => d.attr,
                    };
                    reply.entry(&TTL, &attr, 0);
                    return;
                }
            }
        }
        reply.error(ENOENT);
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyAttr) {
        if let Some(node) = self.inodes.get(&ino) {
            let attr = match node {
                Node::File(f) => f.attr,
                Node::Dir(d) => d.attr,
            };
            reply.attr(&TTL, &attr);
        } else {
            reply.error(ENOENT);
        }
    }

    fn readdir(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        if let Some(Node::Dir(dir)) = self.inodes.get(&ino) {
            let mut entries = vec![(ROOT_INODE, fuser::FileType::Directory, ".".to_string()), (ROOT_INODE, fuser::FileType::Directory, "..".to_string())];
            for (name, &child_ino) in &dir.children {
                let node = self.inodes.get(&child_ino).unwrap();
                let kind = match node {
                    Node::File(_) => fuser::FileType::RegularFile,
                    Node::Dir(_) => fuser::FileType::Directory,
                };
                entries.push((child_ino, kind, name.clone()));
            }
            for (i, (ino, kind, name)) in entries.into_iter().enumerate().skip(offset as usize) {
                if reply.add(ino, (i + 1) as i64, kind, name) {
                    break;
                }
            }
            reply.ok();
        } else {
            reply.error(ENOENT);
        }
    }

    fn mkdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, umask: u32, reply: ReplyEntry) {
        let name_str = name.to_str().unwrap_or("");
        // Avoid double mutable borrow by splitting logic
        let already_exists = if let Some(Node::Dir(dir)) = self.inodes.get(&parent) {
            dir.children.contains_key(name_str)
        } else {
            reply.error(ENOENT);
            return;
        };
        if already_exists {
            reply.error(libc::EEXIST);
            return;
        }
        let ino = self.alloc_inode();
        let attr = fuser::FileAttr {
            ino,
            size: 0,
            blocks: 0,
            atime: UNIX_EPOCH,
            mtime: UNIX_EPOCH,
            ctime: UNIX_EPOCH,
            crtime: UNIX_EPOCH,
            kind: fuser::FileType::Directory,
            perm: (mode & !umask & 0o7777) as u16,
            nlink: 2,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            rdev: 0,
            flags: 0,
            blksize: 512,
        };
        let new_dir = Node::Dir(InMemoryDir {
            name: name_str.to_string(),
            children: BTreeMap::new(),
            attr,
        });
        if let Some(Node::Dir(dir)) = self.inodes.get_mut(&parent) {
            dir.children.insert(name_str.to_string(), ino);
        }
        self.inodes.insert(ino, new_dir);
        reply.entry(&TTL, &attr, 0);
    }

    fn create(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, flags: u32, umask: i32, reply: ReplyCreate) {
        let name_str = name.to_str().unwrap_or("");
        let already_exists = if let Some(Node::Dir(dir)) = self.inodes.get(&parent) {
            dir.children.contains_key(name_str)
        } else {
            reply.error(ENOENT);
            return;
        };
        if already_exists {
            reply.error(libc::EEXIST);
            return;
        }
        let ino = self.alloc_inode();
        let attr = fuser::FileAttr {
            ino,
            size: 0,
            blocks: 0,
            atime: UNIX_EPOCH,
            mtime: UNIX_EPOCH,
            ctime: UNIX_EPOCH,
            crtime: UNIX_EPOCH,
            kind: fuser::FileType::RegularFile,
            perm: (mode & !(umask as u32) & 0o7777) as u16,
            nlink: 1,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            rdev: 0,
            flags: 0,
            blksize: 512,
        };
        let new_file = Node::File(InMemoryFile {
            name: name_str.to_string(),
            data: vec![],
            attr,
        });
        if let Some(Node::Dir(dir)) = self.inodes.get_mut(&parent) {
            dir.children.insert(name_str.to_string(), ino);
        }
        self.inodes.insert(ino, new_file);
        reply.created(&TTL, &attr, 0, 0, 0);
    }

    fn read(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, size: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyData) {
        if let Some(Node::File(file)) = self.inodes.get(&ino) {
            let data = &file.data;
            let end = std::cmp::min((offset as usize) + (size as usize), data.len());
            let start = std::cmp::min(offset as usize, data.len());
            reply.data(&data[start..end]);
        } else {
            reply.error(ENOENT);
        }
    }

    fn write(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, data: &[u8], _write_flags: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyWrite) {
        if let Some(Node::File(file)) = self.inodes.get_mut(&ino) {
            let offset = offset as usize;
            if file.data.len() < offset + data.len() {
                file.data.resize(offset + data.len(), 0);
            }
            file.data[offset..offset + data.len()].copy_from_slice(data);
            file.attr.size = file.data.len() as u64;
            reply.written(data.len() as u32);
        } else {
            reply.error(ENOENT);
        }
    }
}

fn main() {
    TermLogger::init(LevelFilter::Info, Config::default(), TerminalMode::Mixed, ColorChoice::Auto).unwrap();
    let mountpoint = "/tmp/memfs";
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

    let fs = MemFS::new();
    info!("Mounting MemFS at {}", mountpoint);
    fuser::mount2(fs, mountpoint, &[MountOption::FSName("memfs".to_string()), MountOption::AutoUnmount]).unwrap();
}
