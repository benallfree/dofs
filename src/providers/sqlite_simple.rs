use rusqlite::{params, Connection, Result, OptionalExtension};
use std::time::SystemTime;
use fuser;
use crate::providers::Provider;
use serde::{Serialize, Deserialize};
use std::ffi::OsStr;

const ROOT_INODE: u64 = 1;
const USER_INODE_START: u64 = 10; // user files/dirs start here to avoid reserved inodes

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
enum FileTypeRepr {
    RegularFile,
    Directory,
    Symlink,
    BlockDevice,
    CharDevice,
    NamedPipe,
    Socket,
}

impl From<fuser::FileType> for FileTypeRepr {
    fn from(ft: fuser::FileType) -> Self {
        match ft {
            fuser::FileType::RegularFile => FileTypeRepr::RegularFile,
            fuser::FileType::Directory => FileTypeRepr::Directory,
            fuser::FileType::Symlink => FileTypeRepr::Symlink,
            fuser::FileType::BlockDevice => FileTypeRepr::BlockDevice,
            fuser::FileType::CharDevice => FileTypeRepr::CharDevice,
            fuser::FileType::NamedPipe => FileTypeRepr::NamedPipe,
            fuser::FileType::Socket => FileTypeRepr::Socket,
        }
    }
}

impl From<FileTypeRepr> for fuser::FileType {
    fn from(ft: FileTypeRepr) -> Self {
        match ft {
            FileTypeRepr::RegularFile => fuser::FileType::RegularFile,
            FileTypeRepr::Directory => fuser::FileType::Directory,
            FileTypeRepr::Symlink => fuser::FileType::Symlink,
            FileTypeRepr::BlockDevice => fuser::FileType::BlockDevice,
            FileTypeRepr::CharDevice => fuser::FileType::CharDevice,
            FileTypeRepr::NamedPipe => fuser::FileType::NamedPipe,
            FileTypeRepr::Socket => fuser::FileType::Socket,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct SerializableFileAttr {
    ino: u64,
    size: u64,
    blocks: u64,
    atime: SystemTime,
    mtime: SystemTime,
    ctime: SystemTime,
    crtime: SystemTime,
    kind: FileTypeRepr,
    perm: u16,
    nlink: u32,
    uid: u32,
    gid: u32,
    rdev: u32,
    flags: u32,
    blksize: u32,
}

impl From<&fuser::FileAttr> for SerializableFileAttr {
    fn from(attr: &fuser::FileAttr) -> Self {
        SerializableFileAttr {
            ino: attr.ino,
            size: attr.size,
            blocks: attr.blocks,
            atime: attr.atime,
            mtime: attr.mtime,
            ctime: attr.ctime,
            crtime: attr.crtime,
            kind: FileTypeRepr::from(attr.kind),
            perm: attr.perm,
            nlink: attr.nlink,
            uid: attr.uid,
            gid: attr.gid,
            rdev: attr.rdev,
            flags: attr.flags,
            blksize: attr.blksize,
        }
    }
}

impl From<&SerializableFileAttr> for fuser::FileAttr {
    fn from(attr: &SerializableFileAttr) -> Self {
        fuser::FileAttr {
            ino: attr.ino,
            size: attr.size,
            blocks: attr.blocks,
            atime: attr.atime,
            mtime: attr.mtime,
            ctime: attr.ctime,
            crtime: attr.crtime,
            kind: fuser::FileType::from(attr.kind),
            perm: attr.perm,
            nlink: attr.nlink,
            uid: attr.uid,
            gid: attr.gid,
            rdev: attr.rdev,
            flags: attr.flags,
            blksize: attr.blksize,
        }
    }
}

pub struct SqliteProvider {
    conn: Connection,
    next_inode: u64,
    pub osx_mode: bool,
}

impl SqliteProvider {
    #[allow(dead_code)]
    pub fn new(db_path: &str) -> Result<Self> {
        Self::new_with_mode(db_path, false)
    }
    pub fn new_with_mode(db_path: &str, osx_mode: bool) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                ino INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                parent INTEGER,
                is_dir INTEGER NOT NULL,
                data BLOB,
                attr BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_files_parent_name ON files(parent, name);
            CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent);
            CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);"
        )?;
        // Ensure root exists
        {
            let mut stmt = conn.prepare("SELECT COUNT(*) FROM files WHERE ino = ?1")?;
            let count: i64 = stmt.query_row(params![ROOT_INODE], |row| row.get(0))?;
            if count == 0 {
                let now = SystemTime::now();
                let attr = fuser::FileAttr {
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
                let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
                conn.execute(
                    "INSERT INTO files (ino, name, parent, is_dir, data, attr) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![ROOT_INODE, "/", None::<u64>, 1, None::<Vec<u8>>, attr_bytes],
                )?;
            }
        }
        // Find max inode
        let mut next_inode: u64 = conn.query_row(
            "SELECT MAX(ino) FROM files",
            [],
            |row| row.get::<_, Option<u64>>(0),
        )?.unwrap_or(ROOT_INODE);
        if next_inode < USER_INODE_START {
            next_inode = USER_INODE_START;
        } else {
            next_inode += 1;
        }
        Ok(Self { conn, next_inode, osx_mode })
    }
    fn alloc_inode(&mut self) -> u64 {
        let ino = self.next_inode;
        self.next_inode += 1;
        ino
    }
    fn get_attr(&self, ino: u64) -> Option<fuser::FileAttr> {
        self.conn.query_row(
            "SELECT attr FROM files WHERE ino = ?1",
            params![ino],
            |row| {
                let attr_blob: Vec<u8> = row.get(0)?;
                let ser_attr: crate::providers::sqlite_simple::SerializableFileAttr = bincode::deserialize(&attr_blob).unwrap();
                Ok(fuser::FileAttr::from(&ser_attr))
            },
        ).optional().unwrap_or(None)
    }
    fn set_attr(&self, ino: u64, attr: &fuser::FileAttr) {
        let attr_bytes = bincode::serialize(&SerializableFileAttr::from(attr)).unwrap();
        let _ = self.conn.execute(
            "UPDATE files SET attr = ?1 WHERE ino = ?2",
            params![attr_bytes, ino],
        );
    }
    fn get_file_data(&self, ino: u64) -> Option<Vec<u8>> {
        self.conn.query_row(
            "SELECT data FROM files WHERE ino = ?1",
            params![ino],
            |row| row.get(0),
        ).optional().unwrap_or(None)
    }
    fn set_file_data(&self, ino: u64, data: &[u8]) {
        let _ = self.conn.execute(
            "UPDATE files SET data = ?1 WHERE ino = ?2",
            params![data, ino],
        );
    }
    fn get_child_ino(&self, parent: u64, name: &str) -> Option<u64> {
        self.conn.query_row(
            "SELECT ino FROM files WHERE parent = ?1 AND name = ?2",
            params![parent, name],
            |row| row.get(0),
        ).optional().unwrap_or(None)
    }
    fn is_dir_empty(&self, ino: u64) -> bool {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM files WHERE parent = ?1",
            params![ino],
            |row| row.get(0),
        ).unwrap_or(0);
        count == 0
    }
}

impl Provider for SqliteProvider {
    fn rmdir(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        let target_ino = self.get_child_ino(parent, name_str);
        let ino = match target_ino {
            Some(ino) => ino,
            None => { reply.error(libc::ENOENT); return; }
        };
        if !self.is_dir_empty(ino) {
            reply.error(libc::ENOTEMPTY); return;
        }
        let _ = self.conn.execute("DELETE FROM files WHERE ino = ?1", params![ino]);
        let _ = self.conn.execute("DELETE FROM files WHERE parent = ?1 AND name = ?2", params![parent, name_str]);
        reply.ok();
    }
    fn open(&mut self, ino: u64, reply: fuser::ReplyOpen) {
        if self.get_attr(ino).is_some() {
            reply.opened(0, 0);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn flush(&mut self, ino: u64, reply: fuser::ReplyEmpty) {
        if self.get_attr(ino).is_some() {
            reply.ok();
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn release(&mut self, ino: u64, reply: fuser::ReplyEmpty) {
        if self.get_attr(ino).is_some() {
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
        if let Some(mut attr) = self.get_attr(ino) {
            if let Some(m) = mode { attr.perm = m as u16; }
            if let Some(u) = uid { attr.uid = u; }
            if let Some(g) = gid { attr.gid = g; }
            if let Some(a) = atime { attr.atime = timeornow_to_systemtime(a); }
            if let Some(m) = mtime { attr.mtime = timeornow_to_systemtime(m); }
            if let Some(c) = ctime { attr.ctime = c; }
            if let Some(cr) = crtime { attr.crtime = cr; }
            if let Some(fg) = flags { attr.flags = fg; }
            if let Some(new_size) = size {
                let mut data = self.get_file_data(ino).unwrap_or_default();
                data.resize(new_size as usize, 0);
                self.set_file_data(ino, &data);
                attr.size = new_size;
            }
            self.set_attr(ino, &attr);
            reply.attr(&std::time::Duration::from_secs(1), &attr);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn lookup(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEntry) {
        let name = name.to_str().unwrap_or("");
        let ino = self.get_child_ino(parent, name);
        if let Some(ino) = ino {
            if let Some(attr) = self.get_attr(ino) {
                reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
                return;
            }
        }
        reply.error(libc::ENOENT);
    }
    fn getattr(&mut self, ino: u64, reply: fuser::ReplyAttr) {
        if let Some(attr) = self.get_attr(ino) {
            reply.attr(&std::time::Duration::from_secs(1), &attr);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn readdir(&mut self, ino: u64, offset: i64, mut reply: fuser::ReplyDirectory) {
        let mut entries = vec![(ROOT_INODE, fuser::FileType::Directory, ".".to_string()), (ROOT_INODE, fuser::FileType::Directory, "..".to_string())];
        let mut stmt = self.conn.prepare("SELECT ino, name, is_dir FROM files WHERE parent = ?1").unwrap();
        let rows = stmt.query_map(params![ino], |row| {
            let ino: u64 = row.get(0)?;
            let name: String = row.get(1)?;
            let is_dir: i64 = row.get(2)?;
            let kind = if is_dir == 1 { fuser::FileType::Directory } else { fuser::FileType::RegularFile };
            Ok((ino, kind, name))
        }).unwrap();
        for row in rows {
            let (ino, kind, name) = row.unwrap();
            if self.osx_mode && name.starts_with("._") {
                continue;
            }
            entries.push((ino, kind, name));
        }
        for (i, (ino, kind, name)) in entries.into_iter().enumerate().skip(offset as usize) {
            if reply.add(ino, (i + 1) as i64, kind, name) {
                break;
            }
        }
        reply.ok();
    }
    fn mkdir(&mut self, parent: u64, name: &OsStr, mode: u32, umask: u32, reply: fuser::ReplyEntry) {
        let name_str = name.to_str().unwrap_or("");
        if self.osx_mode && name_str.starts_with("._") {
            reply.error(libc::EACCES);
            return;
        }
        if self.get_child_ino(parent, name_str).is_some() {
            reply.error(libc::EEXIST); return;
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
        let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
        let _ = self.conn.execute(
            "INSERT INTO files (ino, name, parent, is_dir, data, attr) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ino, name_str, parent, 1, None::<Vec<u8>>, attr_bytes],
        );
        reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
    }
    fn create(&mut self, parent: u64, name: &OsStr, mode: u32, _flags: u32, umask: i32, reply: fuser::ReplyCreate) {
        let name_str = name.to_str().unwrap_or("");
        if self.osx_mode && name_str.starts_with("._") {
            reply.error(libc::EACCES);
            return;
        }
        if self.get_child_ino(parent, name_str).is_some() {
            reply.error(libc::EEXIST); return;
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
        let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
        let _ = self.conn.execute(
            "INSERT INTO files (ino, name, parent, is_dir, data, attr) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ino, name_str, parent, 0, Vec::<u8>::new(), attr_bytes],
        );
        reply.created(&std::time::Duration::from_secs(1), &attr, 0, 0, 0);
    }
    fn read(&mut self, ino: u64, offset: i64, size: u32, reply: fuser::ReplyData) {
        if let Some(data) = self.get_file_data(ino) {
            let end = std::cmp::min((offset as usize) + (size as usize), data.len());
            let start = std::cmp::min(offset as usize, data.len());
            reply.data(&data[start..end]);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn write(&mut self, ino: u64, offset: i64, data: &[u8], reply: fuser::ReplyWrite) {
        if let Some(mut file_data) = self.get_file_data(ino) {
            let offset = offset as usize;
            if file_data.len() < offset + data.len() {
                file_data.resize(offset + data.len(), 0);
            }
            file_data[offset..offset + data.len()].copy_from_slice(data);
            self.set_file_data(ino, &file_data);
            if let Some(mut attr) = self.get_attr(ino) {
                attr.size = file_data.len() as u64;
                self.set_attr(ino, &attr);
            }
            reply.written(data.len() as u32);
        } else {
            reply.error(libc::ENOENT);
        }
    }
    fn unlink(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        let target_ino = self.get_child_ino(parent, name_str);
        let ino = match target_ino {
            Some(ino) => ino,
            None => { reply.error(libc::ENOENT); return; }
        };
        let _ = self.conn.execute("DELETE FROM files WHERE ino = ?1", params![ino]);
        reply.ok();
    }
} 