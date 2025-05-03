use fuser::{Filesystem, Request, ReplyAttr, ReplyEntry, ReplyDirectory, ReplyData, ReplyCreate, ReplyWrite};
use libc::ENOENT;
use std::collections::{HashMap, BTreeMap};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(1); // 1 second
const ROOT_INODE: u64 = 1;

#[derive(Debug, Clone)]
pub struct InMemoryFile {
    pub name: String,
    pub data: Vec<u8>,
    pub attr: fuser::FileAttr,
}

#[derive(Debug, Clone)]
pub struct InMemoryDir {
    pub name: String,
    pub children: BTreeMap<String, u64>, // name -> inode
    pub attr: fuser::FileAttr,
}

#[derive(Debug)]
pub struct FuseFS {
    pub inodes: HashMap<u64, Node>,
    pub paths: HashMap<PathBuf, u64>,
    pub next_inode: u64,
}

#[derive(Debug, Clone)]
pub enum Node {
    File(InMemoryFile),
    Dir(InMemoryDir),
}

impl FuseFS {
    pub fn new() -> Self {
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

    pub fn alloc_inode(&mut self) -> u64 {
        let ino = self.next_inode;
        self.next_inode += 1;
        ino
    }
}

impl Filesystem for FuseFS {
    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &std::ffi::OsStr, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        let target_ino = if let Some(Node::Dir(parent_dir)) = self.inodes.get(&parent) {
            parent_dir.children.get(name_str).copied()
        } else {
            reply.error(libc::ENOENT);
            return;
        };
        let ino = match target_ino {
            Some(ino) => ino,
            None => {
                reply.error(libc::ENOENT);
                return;
            }
        };
        let is_empty_dir = if let Some(Node::Dir(dir)) = self.inodes.get(&ino) {
            dir.children.is_empty()
        } else {
            reply.error(libc::ENOTDIR);
            return;
        };
        if !is_empty_dir {
            reply.error(libc::ENOTEMPTY);
            return;
        }
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