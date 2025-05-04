use std::collections::{HashMap, BTreeMap};
use std::path::PathBuf;
use std::ffi::OsStr;
use std::time::SystemTime;
use fuser;
use crate::providers::Provider;

const ROOT_INODE: u64 = 1;
const USER_INODE_START: u64 = 10;

#[derive(Debug, Clone)]
pub struct InMemoryFile {
    pub data: Vec<u8>,
    pub attr: fuser::FileAttr,
}

#[derive(Debug, Clone)]
pub struct InMemoryDir {
    pub children: BTreeMap<String, u64>,
    pub attr: fuser::FileAttr,
}

#[derive(Debug, Clone)]
pub struct InMemorySymlink {
    pub target: String,
    pub attr: fuser::FileAttr,
}

#[derive(Debug, Clone)]
pub enum Node {
    File(InMemoryFile),
    Dir(InMemoryDir),
    Symlink(InMemorySymlink),
}

pub struct MemoryProvider {
    pub inodes: HashMap<u64, Node>,
    #[allow(dead_code)]
    pub paths: HashMap<PathBuf, u64>,
    pub next_inode: u64,
    #[allow(dead_code)]
    pub xattrs: HashMap<(u64, String), Vec<u8>>,
    pub osx_mode: bool,
}

impl MemoryProvider {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::new_with_mode(false)
    }
    pub fn new_with_mode(osx_mode: bool) -> Self {
        let mut inodes = HashMap::new();
        let mut paths = HashMap::new();
        let now = SystemTime::now();
        let root_attr = fuser::FileAttr {
            ino: ROOT_INODE,
            size: 0,
            blocks: 0,
            atime: now,
            mtime: now,
            ctime: now,
            crtime: now,
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
            children: BTreeMap::new(),
            attr: root_attr,
        });
        inodes.insert(ROOT_INODE, root);
        paths.insert(PathBuf::from("/"), ROOT_INODE);
        Self { inodes, paths, next_inode: USER_INODE_START, xattrs: HashMap::new(), osx_mode }
    }
    pub fn alloc_inode(&mut self) -> u64 {
        let ino = self.next_inode;
        self.next_inode += 1;
        ino
    }
}

impl Provider for MemoryProvider {
    fn rmdir(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
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
    fn open(&mut self, ino: u64, reply: fuser::ReplyOpen) {
        if self.inodes.contains_key(&ino) {
            reply.opened(0, 0);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn flush(&mut self, ino: u64, reply: fuser::ReplyEmpty) {
        if self.inodes.contains_key(&ino) {
            reply.ok();
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn release(&mut self, ino: u64, reply: fuser::ReplyEmpty) {
        if self.inodes.contains_key(&ino) {
            reply.ok();
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn setattr(&mut self, ino: u64, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, atime: Option<fuser::TimeOrNow>, mtime: Option<fuser::TimeOrNow>, ctime: Option<SystemTime>, crtime: Option<SystemTime>, flags: Option<u32>, reply: fuser::ReplyAttr) {
        fn timeornow_to_systemtime(t: fuser::TimeOrNow) -> SystemTime {
            match t {
                fuser::TimeOrNow::SpecificTime(st) => st,
                fuser::TimeOrNow::Now => SystemTime::now(),
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
                    reply.attr(&std::time::Duration::from_secs(1), &f.attr);
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
                    reply.attr(&std::time::Duration::from_secs(1), &d.attr);
                }
                Node::Symlink(s) => {
                    if let Some(m) = mode { s.attr.perm = m as u16; }
                    if let Some(u) = uid { s.attr.uid = u; }
                    if let Some(g) = gid { s.attr.gid = g; }
                    if let Some(a) = atime { s.attr.atime = timeornow_to_systemtime(a); }
                    if let Some(m) = mtime { s.attr.mtime = timeornow_to_systemtime(m); }
                    if let Some(c) = ctime { s.attr.ctime = c; }
                    if let Some(cr) = crtime { s.attr.crtime = cr; }
                    if let Some(fg) = flags { s.attr.flags = fg; }
                    reply.attr(&std::time::Duration::from_secs(1), &s.attr);
                }
            }
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn lookup(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEntry) {
        let name = name.to_str().unwrap_or("");
        let parent_node = self.inodes.get(&parent);
        if let Some(Node::Dir(dir)) = parent_node {
            if let Some(&child_ino) = dir.children.get(name) {
                if let Some(node) = self.inodes.get(&child_ino) {
                    let attr = match node {
                        Node::File(f) => f.attr,
                        Node::Dir(d) => d.attr,
                        Node::Symlink(s) => s.attr,
                    };
                    reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
                    return;
                }
            }
        }
        reply.error(libc::ENOENT);
    }
    fn getattr(&mut self, ino: u64, reply: fuser::ReplyAttr) {
        if let Some(node) = self.inodes.get(&ino) {
            let attr = match node {
                Node::File(f) => f.attr,
                Node::Dir(d) => d.attr,
                Node::Symlink(s) => s.attr,
            };
            reply.attr(&std::time::Duration::from_secs(1), &attr);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn readdir(&mut self, ino: u64, offset: i64, mut reply: fuser::ReplyDirectory) {
        if let Some(Node::Dir(dir)) = self.inodes.get(&ino) {
            let mut entries = vec![(ROOT_INODE, fuser::FileType::Directory, ".".to_string()), (ROOT_INODE, fuser::FileType::Directory, "..".to_string())];
            for (name, &child_ino) in &dir.children {
                if self.osx_mode && name.starts_with("._") {
                    continue;
                }
                let node = self.inodes.get(&child_ino).unwrap();
                let kind = match node {
                    Node::File(_) => fuser::FileType::RegularFile,
                    Node::Dir(_) => fuser::FileType::Directory,
                    Node::Symlink(_) => fuser::FileType::Symlink,
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
            reply.error(libc::ENOENT);
        }
    }
    fn mkdir(&mut self, parent: u64, name: &OsStr, mode: u32, umask: u32, reply: fuser::ReplyEntry) {
        let name_str = name.to_str().unwrap_or("");
        if self.osx_mode && name_str.starts_with("._") {
            reply.error(libc::EACCES);
            return;
        }
        let already_exists = if let Some(Node::Dir(dir)) = self.inodes.get(&parent) {
            dir.children.contains_key(name_str)
        } else {
            reply.error(libc::ENOENT);
            return;
        };
        if already_exists {
            reply.error(libc::EEXIST);
            return;
        }
        let ino = self.alloc_inode();
        let now = SystemTime::now();
        let attr = fuser::FileAttr {
            ino,
            size: 0,
            blocks: 0,
            atime: now,
            mtime: now,
            ctime: now,
            crtime: now,
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
            children: BTreeMap::new(),
            attr,
        });
        if let Some(Node::Dir(dir)) = self.inodes.get_mut(&parent) {
            dir.children.insert(name_str.to_string(), ino);
        }
        self.inodes.insert(ino, new_dir);
        reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
    }
    fn create(&mut self, parent: u64, name: &OsStr, mode: u32, _flags: u32, umask: i32, reply: fuser::ReplyCreate) {
        let name_str = name.to_str().unwrap_or("");
        if self.osx_mode && name_str.starts_with("._") {
            reply.error(libc::EACCES);
            return;
        }
        let already_exists = if let Some(Node::Dir(dir)) = self.inodes.get(&parent) {
            dir.children.contains_key(name_str)
        } else {
            reply.error(libc::ENOENT);
            return;
        };
        if already_exists {
            reply.error(libc::EEXIST);
            return;
        }
        let ino = self.alloc_inode();
        let now = SystemTime::now();
        let attr = fuser::FileAttr {
            ino,
            size: 0,
            blocks: 0,
            atime: now,
            mtime: now,
            ctime: now,
            crtime: now,
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
            data: vec![],
            attr,
        });
        if let Some(Node::Dir(dir)) = self.inodes.get_mut(&parent) {
            dir.children.insert(name_str.to_string(), ino);
        }
        self.inodes.insert(ino, new_file);
        reply.created(&std::time::Duration::from_secs(1), &attr, 0, 0, 0);
    }
    fn read(&mut self, ino: u64, offset: i64, size: u32, reply: fuser::ReplyData) {
        if let Some(Node::File(file)) = self.inodes.get(&ino) {
            let data = &file.data;
            let end = std::cmp::min((offset as usize) + (size as usize), data.len());
            let start = std::cmp::min(offset as usize, data.len());
            reply.data(&data[start..end]);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn write(&mut self, ino: u64, offset: i64, data: &[u8], reply: fuser::ReplyWrite) {
        if let Some(Node::File(file)) = self.inodes.get_mut(&ino) {
            let offset = offset as usize;
            if file.data.len() < offset + data.len() {
                file.data.resize(offset + data.len(), 0);
            }
            file.data[offset..offset + data.len()].copy_from_slice(data);
            file.attr.size = file.data.len() as u64;
            reply.written(data.len() as u32);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn unlink(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
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
        match self.inodes.get(&ino) {
            Some(Node::File(_)) | Some(Node::Symlink(_)) => {
                if let Some(Node::Dir(parent_dir)) = self.inodes.get_mut(&parent) {
                    parent_dir.children.remove(name_str);
                }
                self.inodes.remove(&ino);
                reply.ok();
            }
            Some(Node::Dir(_)) => {
                reply.error(libc::EISDIR);
            }
            None => {
                reply.error(libc::ENOENT);
            }
        }
    }
    fn rename(&mut self, parent: u64, name: &OsStr, newparent: u64, newname: &OsStr, _flags: u32, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        let newname_str = newname.to_str().unwrap_or("");
        // Get source parent dir
        let src_is_dir = matches!(self.inodes.get(&parent), Some(Node::Dir(_)));
        let dst_is_dir = matches!(self.inodes.get(&newparent), Some(Node::Dir(_)));
        if !src_is_dir || !dst_is_dir {
            reply.error(libc::ENOTDIR);
            return;
        }
        // Check source exists and get inode
        let ino = {
            let src_parent = match self.inodes.get(&parent) {
                Some(Node::Dir(dir)) => dir,
                _ => { reply.error(libc::ENOTDIR); return; }
            };
            match src_parent.children.get(name_str) {
                Some(&ino) => ino,
                None => { reply.error(libc::ENOENT); return; }
            }
        };
        // Check dest exists
        let dest_exists = {
            let dst_parent = match self.inodes.get(&newparent) {
                Some(Node::Dir(dir)) => dir,
                _ => { reply.error(libc::ENOTDIR); return; }
            };
            dst_parent.children.contains_key(newname_str)
        };
        if dest_exists {
            reply.error(libc::EEXIST);
            return;
        }
        // Now do the mutation
        if let Some(Node::Dir(src_parent)) = self.inodes.get_mut(&parent) {
            src_parent.children.remove(name_str);
        }
        if let Some(Node::Dir(dst_parent)) = self.inodes.get_mut(&newparent) {
            dst_parent.children.insert(newname_str.to_string(), ino);
        }
        reply.ok();
    }
    fn symlink(&mut self, parent: u64, name: &OsStr, link: &std::path::Path, reply: fuser::ReplyEntry) {
        let name_str = name.to_str().unwrap_or("");
        if self.osx_mode && name_str.starts_with("._") {
            reply.error(libc::EACCES);
            return;
        }
        let already_exists = if let Some(Node::Dir(dir)) = self.inodes.get(&parent) {
            dir.children.contains_key(name_str)
        } else {
            reply.error(libc::ENOENT);
            return;
        };
        if already_exists {
            reply.error(libc::EEXIST);
            return;
        }
        let ino = self.alloc_inode();
        let now = SystemTime::now();
        let target = link.to_string_lossy().to_string();
        let attr = fuser::FileAttr {
            ino,
            size: target.len() as u64,
            blocks: 0,
            atime: now,
            mtime: now,
            ctime: now,
            crtime: now,
            kind: fuser::FileType::Symlink,
            perm: 0o777,
            nlink: 1,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            rdev: 0,
            flags: 0,
            blksize: 512,
        };
        let symlink = Node::Symlink(InMemorySymlink { target, attr });
        if let Some(Node::Dir(dir)) = self.inodes.get_mut(&parent) {
            dir.children.insert(name_str.to_string(), ino);
        }
        self.inodes.insert(ino, symlink);
        reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
    }
    fn readlink(&mut self, ino: u64, reply: fuser::ReplyData) {
        if let Some(Node::Symlink(s)) = self.inodes.get(&ino) {
            reply.data(s.target.as_bytes());
        } else {
            reply.error(libc::EINVAL);
        }
    }
} 