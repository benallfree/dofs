use rusqlite::{params, Connection, Result, OptionalExtension};
use std::ffi::OsStr;
use std::time::SystemTime;
use fuser;
use serde::{Serialize, Deserialize};

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
        // Ensure timestamps are within valid range to prevent overflow
        let now = SystemTime::now();
        let safe_time = |t: SystemTime| -> SystemTime {
            // If timestamp is more than 100 years in the future, use current time
            if let Ok(duration_since_epoch) = t.duration_since(std::time::UNIX_EPOCH) {
                if duration_since_epoch.as_secs() > now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() + (100 * 365 * 24 * 3600) {
                    now
                } else {
                    t
                }
            } else {
                // If before epoch, use epoch
                std::time::UNIX_EPOCH
            }
        };
        
        fuser::FileAttr {
            ino: attr.ino,
            size: attr.size,
            blocks: attr.blocks,
            atime: safe_time(attr.atime),
            mtime: safe_time(attr.mtime),
            ctime: safe_time(attr.ctime),
            crtime: safe_time(attr.crtime),
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

pub struct SqliteChunkedProvider {
    conn: Connection,
    next_inode: u64,
    pub osx_mode: bool,
    pub chunk_size: usize,
}

impl SqliteChunkedProvider {
    const SCHEMA: &'static str = "CREATE TABLE IF NOT EXISTS files (
                ino INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                parent INTEGER,
                is_dir INTEGER NOT NULL,
                attr BLOB,
                data BLOB
            );
            CREATE TABLE IF NOT EXISTS chunks (
                ino INTEGER NOT NULL,
                offset INTEGER NOT NULL,
                data BLOB NOT NULL,
                length INTEGER NOT NULL,
                PRIMARY KEY (ino, offset)
            );
            CREATE INDEX IF NOT EXISTS idx_files_parent_name ON files(parent, name);
            CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent);
            CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
            CREATE INDEX IF NOT EXISTS idx_chunks_ino ON chunks(ino);
            CREATE INDEX IF NOT EXISTS idx_chunks_ino_offset ON chunks(ino, offset);";
    fn root_dir_attr() -> fuser::FileAttr {
        let now = SystemTime::now();
        fuser::FileAttr {
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
        }
    }
    #[allow(dead_code)]
    pub fn new(db_path: &str, chunk_size: Option<usize>) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(Self::SCHEMA)?;
        // Ensure root exists
        {
            let mut stmt = conn.prepare("SELECT COUNT(*) FROM files WHERE ino = ?1")?;
            let count: i64 = stmt.query_row(params![ROOT_INODE], |row| row.get(0))?;
            if count == 0 {
                let attr = Self::root_dir_attr();
                let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
                conn.execute(
                    "INSERT INTO files (ino, name, parent, is_dir, attr, data) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                    params![ROOT_INODE, "/", None::<u64>, 1, attr_bytes],
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
        Ok(Self { conn, next_inode, osx_mode: false, chunk_size: chunk_size.unwrap_or(4096) })
    }
    pub fn new_with_mode(db_path: &str, osx_mode: bool, chunk_size: usize) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(Self::SCHEMA)?;
        // Ensure root exists
        {
            let mut stmt = conn.prepare("SELECT COUNT(*) FROM files WHERE ino = ?1")?;
            let count: i64 = stmt.query_row(params![ROOT_INODE], |row| row.get(0))?;
            if count == 0 {
                let attr = Self::root_dir_attr();
                let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
                conn.execute(
                    "INSERT INTO files (ino, name, parent, is_dir, attr, data) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                    params![ROOT_INODE, "/", None::<u64>, 1, attr_bytes],
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
        Ok(Self { conn, next_inode, osx_mode, chunk_size })
    }
    #[allow(dead_code)]
    fn get_file_data(&self, ino: u64) -> Option<Vec<u8>> {
        // Minimal stub: just return all chunks concatenated (not efficient, but placeholder)
        let mut stmt = self.conn.prepare("SELECT offset, data, length FROM chunks WHERE ino = ?1 ORDER BY offset ASC").ok()?;
        let mut rows = stmt.query(params![ino]).ok()?;
        let mut data = Vec::new();
        while let Some(row) = rows.next().ok()? {
            let offset: i64 = row.get(0).ok()?;
            let chunk_data: Vec<u8> = row.get(1).ok()?;
            let length: i64 = row.get(2).ok()?;
            if data.len() < (offset as usize) {
                data.resize(offset as usize, 0);
            }
            if data.len() < (offset as usize + length as usize) {
                data.resize(offset as usize + length as usize, 0);
            }
            data[offset as usize..offset as usize + length as usize].copy_from_slice(&chunk_data[..length as usize]);
        }
        Some(data)
    }
    #[allow(dead_code)]
    fn set_file_data(&self, ino: u64, data: &[u8]) {
        // Minimal stub: delete all chunks and insert a single chunk
        let _ = self.conn.execute("DELETE FROM chunks WHERE ino = ?1", params![ino]);
        let _ = self.conn.execute(
            "INSERT INTO chunks (ino, offset, data, length) VALUES (?1, ?2, ?3, ?4)",
            params![ino, 0i64, data, data.len() as i64],
        );
    }
    fn get_attr(&self, ino: u64) -> Option<fuser::FileAttr> {
        self.conn.query_row(
            "SELECT attr FROM files WHERE ino = ?1",
            params![ino],
            |row| {
                let attr_blob: Vec<u8> = row.get(0)?;
                let ser_attr: SerializableFileAttr = bincode::deserialize(&attr_blob).unwrap();
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
    fn get_file_size(&self, ino: u64) -> u64 {
        self.get_attr(ino).map(|attr| attr.size).unwrap_or(0)
    }
    fn set_file_size(&self, ino: u64, size: u64) {
        if let Some(mut attr) = self.get_attr(ino) {
            attr.size = size;
            self.set_attr(ino, &attr);
        }
    }
    fn get_file_data_range(&self, ino: u64, offset: usize, size: usize) -> Vec<u8> {
        let mut result = vec![0u8; size];
        let chunk_size = self.chunk_size;
        let start_chunk = offset / chunk_size;
        let end_chunk = (offset + size + chunk_size - 1) / chunk_size;
        let mut stmt = self.conn.prepare(
            "SELECT offset, data, length FROM chunks WHERE ino = ?1 AND offset >= ?2 AND offset < ?3 ORDER BY offset ASC"
        ).unwrap();
        let chunk_start = (start_chunk * chunk_size) as i64;
        let chunk_end = (end_chunk * chunk_size) as i64;
        let mut rows = stmt.query(params![ino, chunk_start, chunk_end]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let chunk_offset: i64 = row.get(0).unwrap();
            let chunk_data: Vec<u8> = row.get(1).unwrap();
            let chunk_len: i64 = row.get(2).unwrap();
            let chunk_offset_usize = chunk_offset as usize;
            let chunk_start_in_file = chunk_offset_usize;
            let chunk_end_in_file = chunk_offset_usize + chunk_len as usize;
            let read_start = offset.max(chunk_start_in_file);
            let read_end = (offset + size).min(chunk_end_in_file);
            if read_start < read_end {
                let dest_start = read_start - offset;
                let src_start = read_start - chunk_start_in_file;
                let len = read_end - read_start;
                result[dest_start..dest_start + len].copy_from_slice(&chunk_data[src_start..src_start + len]);
            }
        }
        result
    }
    fn write_file_data(&self, ino: u64, offset: usize, data: &[u8]) {
        let chunk_size = self.chunk_size;
        let tx = self.conn.unchecked_transaction().unwrap();
        let mut written = 0;
        while written < data.len() {
            let abs_offset = offset + written;
            let chunk_idx = abs_offset / chunk_size;
            let chunk_offset = chunk_idx * chunk_size;
            let chunk_off_in_chunk = abs_offset % chunk_size;
            let write_len = (chunk_size - chunk_off_in_chunk).min(data.len() - written);
            // Read existing chunk if present
            let mut chunk_data: Vec<u8> = tx.query_row(
                "SELECT data FROM chunks WHERE ino = ?1 AND offset = ?2",
                params![ino, chunk_offset as i64],
                |row| row.get(0),
            ).optional().unwrap_or(None).unwrap_or(vec![0u8; chunk_size]);
            if chunk_data.len() < chunk_size {
                chunk_data.resize(chunk_size, 0);
            }
            chunk_data[chunk_off_in_chunk..chunk_off_in_chunk + write_len]
                .copy_from_slice(&data[written..written + write_len]);
            // Calculate new chunk length
            let mut chunk_length = chunk_size;
            // If this is the last chunk, length may be less
            let file_end = abs_offset + write_len;
            let new_file_size = self.get_file_size(ino).max(file_end as u64);
            if (chunk_offset + chunk_size) as u64 > new_file_size {
                chunk_length = (new_file_size as usize - chunk_offset).min(chunk_size);
            }
            // Upsert chunk
            let _ = tx.execute(
                "INSERT INTO chunks (ino, offset, data, length) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(ino, offset) DO UPDATE SET data=excluded.data, length=excluded.length",
                params![ino, chunk_offset as i64, &chunk_data[..chunk_length], chunk_length as i64],
            );
            written += write_len;
        }
        tx.commit().unwrap();
        let new_size = (offset + data.len()).max(self.get_file_size(ino) as usize) as u64;
        self.set_file_size(ino, new_size);
    }
    fn truncate_file(&self, ino: u64, size: u64) {
        let chunk_size = self.chunk_size as u64;
        let tx = self.conn.unchecked_transaction().unwrap();
        // Delete all chunks past the new size
        let first_excess_chunk = (size / chunk_size) * chunk_size;
        let _ = tx.execute(
            "DELETE FROM chunks WHERE ino = ?1 AND offset >= ?2",
            params![ino, first_excess_chunk as i64],
        );
        // If the last chunk is partial, trim it
        if size % chunk_size != 0 {
            let last_chunk_offset = (size / chunk_size) * chunk_size;
            let last_len = (size % chunk_size) as i64;
            let chunk_data: Option<Vec<u8>> = tx.query_row(
                "SELECT data FROM chunks WHERE ino = ?1 AND offset = ?2",
                params![ino, last_chunk_offset as i64],
                |row| row.get(0),
            ).optional().unwrap_or(None);
            if let Some(mut chunk_data) = chunk_data {
                chunk_data.resize(last_len as usize, 0);
                let _ = tx.execute(
                    "UPDATE chunks SET data = ?1, length = ?2 WHERE ino = ?3 AND offset = ?4",
                    params![&chunk_data, last_len, ino, last_chunk_offset as i64],
                );
            }
        }
        tx.commit().unwrap();
        self.set_file_size(ino, size);
    }
    fn delete_file_chunks(&self, ino: u64) {
        let _ = self.conn.execute("DELETE FROM chunks WHERE ino = ?1", params![ino]);
    }
    fn alloc_inode(&mut self) -> u64 {
        let ino = self.next_inode;
        self.next_inode += 1;
        ino
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
    fn new_file_attr(ino: u64, kind: fuser::FileType, perm: u16, nlink: u32, size: u64) -> fuser::FileAttr {
        let now = SystemTime::now();
        fuser::FileAttr {
            ino,
            size,
            blocks: 0,
            atime: now,
            mtime: now,
            ctime: now,
            crtime: now,
            kind,
            perm,
            nlink,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            rdev: 0,
            flags: 0,
            blksize: 512,
        }
    }
    fn insert_file(&self, ino: u64, name: &str, parent: u64, is_dir: bool, attr_bytes: Vec<u8>) {
        let _ = self.conn.execute(
            "INSERT INTO files (ino, name, parent, is_dir, attr) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ino, name, parent, if is_dir { 1 } else { 0 }, attr_bytes],
        );
    }
}

impl crate::providers::Provider for SqliteChunkedProvider {
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
        self.delete_file_chunks(ino);
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
        fn safe_systemtime(t: SystemTime) -> SystemTime {
            // Ensure timestamp is within valid range
            let now = SystemTime::now();
            if let Ok(duration_since_epoch) = t.duration_since(std::time::UNIX_EPOCH) {
                if duration_since_epoch.as_secs() > now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() + (100 * 365 * 24 * 3600) {
                    now
                } else {
                    t
                }
            } else {
                std::time::UNIX_EPOCH
            }
        }
        if let Some(mut attr) = self.get_attr(ino) {
            if let Some(m) = mode { attr.perm = m as u16; }
            if let Some(u) = uid { attr.uid = u; }
            if let Some(g) = gid { attr.gid = g; }
            if let Some(a) = atime { attr.atime = timeornow_to_systemtime(a); }
            if let Some(m) = mtime { attr.mtime = timeornow_to_systemtime(m); }
            if let Some(c) = ctime { attr.ctime = safe_systemtime(c); }
            if let Some(cr) = crtime { attr.crtime = safe_systemtime(cr); }
            if let Some(fg) = flags { attr.flags = fg; }
            if let Some(new_size) = size {
                self.truncate_file(ino, new_size);
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
        let mut stmt = self.conn.prepare("SELECT ino, name, is_dir, attr FROM files WHERE parent = ?1").unwrap();
        let rows = stmt.query_map(params![ino], |row| {
            let ino: u64 = row.get(0)?;
            let name: String = row.get(1)?;
            let _is_dir: i64 = row.get(2)?;
            let attr_blob: Vec<u8> = row.get(3)?;
            let ser_attr: SerializableFileAttr = bincode::deserialize(&attr_blob).unwrap();
            let kind = fuser::FileType::from(ser_attr.kind);
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
        let perm = (mode & !umask & 0o7777) as u16;
        let attr = Self::new_file_attr(ino, fuser::FileType::Directory, perm, 2, 0);
        let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
        self.insert_file(ino, name_str, parent, true, attr_bytes);
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
        let perm = (mode & !(umask as u32) & 0o7777) as u16;
        let attr = Self::new_file_attr(ino, fuser::FileType::RegularFile, perm, 1, 0);
        let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
        self.insert_file(ino, name_str, parent, false, attr_bytes);
        reply.created(&std::time::Duration::from_secs(1), &attr, 0, 0, 0);
    }
    fn read(&mut self, ino: u64, offset: i64, size: u32, reply: fuser::ReplyData) {
        if let Some(attr) = self.get_attr(ino) {
            if attr.kind == fuser::FileType::Symlink {
                reply.error(libc::EINVAL);
                return;
            }
        }
        let file_size = self.get_file_size(ino);
        if offset as u64 >= file_size {
            reply.data(&[]);
            return;
        }
        let read_size = std::cmp::min(size as u64, file_size.saturating_sub(offset as u64)) as usize;
        let data = self.get_file_data_range(ino, offset as usize, read_size);
        reply.data(&data);
    }
    fn write(&mut self, ino: u64, offset: i64, data: &[u8], reply: fuser::ReplyWrite) {
        self.write_file_data(ino, offset as usize, data);
        reply.written(data.len() as u32);
    }
    fn unlink(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        let target_ino = self.get_child_ino(parent, name_str);
        let ino = match target_ino {
            Some(ino) => ino,
            None => { reply.error(libc::ENOENT); return; }
        };
        let _ = self.conn.execute("DELETE FROM files WHERE ino = ?1", params![ino]);
        self.delete_file_chunks(ino);
        reply.ok();
    }
    fn rename(&mut self, parent: u64, name: &OsStr, newparent: u64, newname: &OsStr, _flags: u32, reply: fuser::ReplyEmpty) {
        let name_str = name.to_str().unwrap_or("");
        let newname_str = newname.to_str().unwrap_or("");
        // Find the inode to move
        let ino = match self.get_child_ino(parent, name_str) {
            Some(ino) => ino,
            None => { reply.error(libc::ENOENT); return; }
        };
        // If destination exists, remove it (file or empty dir)
        if let Some(dest_ino) = self.get_child_ino(newparent, newname_str) {
            // Check if it's a directory and not empty
            if let Some(attr) = self.get_attr(dest_ino) {
                if attr.kind == fuser::FileType::Directory && !self.is_dir_empty(dest_ino) {
                    reply.error(libc::ENOTEMPTY);
                    return;
                }
            }
            let _ = self.conn.execute("DELETE FROM files WHERE ino = ?1", params![dest_ino]);
            let _ = self.conn.execute("DELETE FROM files WHERE parent = ?1 AND name = ?2", params![newparent, newname_str]);
            self.delete_file_chunks(dest_ino);
        }
        // Update the file's parent and name
        let res = self.conn.execute(
            "UPDATE files SET parent = ?1, name = ?2 WHERE ino = ?3",
            params![newparent, newname_str, ino],
        );
        if res.is_ok() {
            // Remove the old name entry if parent/name changed
            let _ = self.conn.execute(
                "DELETE FROM files WHERE parent = ?1 AND name = ?2 AND ino != ?3",
                params![parent, name_str, ino],
            );
            reply.ok();
        } else {
            reply.error(libc::EIO);
        }
    }
    fn symlink(&mut self, parent: u64, name: &OsStr, link: &std::path::Path, reply: fuser::ReplyEntry) {
        let name_str = name.to_str().unwrap_or("");
        if self.osx_mode && name_str.starts_with("._") {
            reply.error(libc::EACCES);
            return;
        }
        if self.get_child_ino(parent, name_str).is_some() {
            reply.error(libc::EEXIST); return;
        }
        let ino = self.alloc_inode();
        let target = link.to_string_lossy().to_string().into_bytes();
        let attr = Self::new_file_attr(ino, fuser::FileType::Symlink, 0o777, 1, target.len() as u64);
        let attr_bytes = bincode::serialize(&SerializableFileAttr::from(&attr)).unwrap();
        let _ = self.conn.execute(
            "INSERT INTO files (ino, name, parent, is_dir, attr, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ino, name_str, parent, 0, attr_bytes, target],
        );
        reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
    }
    fn readlink(&mut self, ino: u64, reply: fuser::ReplyData) {
        let attr = self.get_attr(ino);
        if let Some(attr) = attr {
            if attr.kind == fuser::FileType::Symlink {
                let data: Option<Vec<u8>> = self.conn.query_row(
                    "SELECT data FROM files WHERE ino = ?1",
                    params![ino],
                    |row| row.get(0),
                ).optional().unwrap_or(None);
                if let Some(data) = data {
                    reply.data(&data);
                    return;
                }
            }
        }
        reply.error(libc::EINVAL);
    }
} 