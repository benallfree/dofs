use fuser::{Filesystem, Request, ReplyAttr, ReplyEntry, ReplyDirectory, ReplyData, ReplyCreate, ReplyWrite};
use crate::providers::Provider;
use std::ffi::OsStr;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct FuseFS {
    pub provider: Box<dyn Provider + Send>,
    mount_time_ms: u128,
}

impl FuseFS {
    pub fn new(provider: Box<dyn Provider + Send>) -> Self {
        let mount_time_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        Self { provider, mount_time_ms }
    }

    fn fuse_ready_attr(&self) -> fuser::FileAttr {
        let mount_time = UNIX_EPOCH + std::time::Duration::from_millis(self.mount_time_ms as u64);
        fuser::FileAttr {
            ino: FUSE_READY_INO,
            size: self.mount_time_ms.to_string().len() as u64,
            blocks: 1,
            atime: mount_time,
            mtime: mount_time,
            ctime: mount_time,
            crtime: mount_time,
            kind: fuser::FileType::RegularFile,
            perm: 0o444,
            nlink: 1,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            rdev: 0,
            flags: 0,
            blksize: 512,
        }
    }
}

const FUSE_READY_NAME: &str = ".fuse_ready";
const FUSE_READY_INO: u64 = 2;

impl Filesystem for FuseFS {
    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        self.provider.rmdir(parent, name, reply)
    }
    fn open(&mut self, _req: &Request<'_>, ino: u64, _flags: i32, reply: fuser::ReplyOpen) {
        self.provider.open(ino, reply)
    }
    fn flush(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, _lock_owner: u64, reply: fuser::ReplyEmpty) {
        self.provider.flush(ino, reply)
    }
    fn release(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, _flags: i32, _lock_owner: Option<u64>, _flush: bool, reply: fuser::ReplyEmpty) {
        self.provider.release(ino, reply)
    }
    fn setattr(&mut self, _req: &Request<'_>, ino: u64, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, atime: Option<fuser::TimeOrNow>, mtime: Option<fuser::TimeOrNow>, ctime: Option<std::time::SystemTime>, _fh: Option<u64>, crtime: Option<std::time::SystemTime>, _chgtime: Option<std::time::SystemTime>, _bkuptime: Option<std::time::SystemTime>, flags: Option<u32>, reply: ReplyAttr) {
        self.provider.setattr(ino, mode, uid, gid, size, atime, mtime, ctime, crtime, flags, reply)
    }
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        if parent == 1 && name.to_str() == Some(FUSE_READY_NAME) {
            let attr = self.fuse_ready_attr();
            reply.entry(&std::time::Duration::from_secs(1), &attr, 0);
            return;
        }
        self.provider.lookup(parent, name, reply)
    }
    fn getattr(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyAttr) {
        if ino == FUSE_READY_INO {
            let attr = self.fuse_ready_attr();
            reply.attr(&std::time::Duration::from_secs(1), &attr);
            return;
        }
        self.provider.getattr(ino, reply)
    }
    fn readdir(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, reply: ReplyDirectory) {
        self.provider.readdir(ino, offset, reply)
    }
    fn mkdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, umask: u32, reply: ReplyEntry) {
        self.provider.mkdir(parent, name, mode, umask, reply)
    }
    fn create(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, flags: u32, umask: i32, reply: ReplyCreate) {
        self.provider.create(parent, name, mode, flags, umask, reply)
    }
    fn read(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, size: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyData) {
        if ino == FUSE_READY_INO {
            let data = self.mount_time_ms.to_string().into_bytes();
            let start = std::cmp::min(offset as usize, data.len());
            let end = std::cmp::min(start + size as usize, data.len());
            reply.data(&data[start..end]);
            return;
        }
        self.provider.read(ino, offset, size, reply)
    }
    fn write(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, data: &[u8], _write_flags: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyWrite) {
        self.provider.write(ino, offset, data, reply)
    }
    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        self.provider.unlink(parent, name, reply)
    }
    fn rename(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, newparent: u64, newname: &OsStr, flags: u32, reply: fuser::ReplyEmpty) {
        self.provider.rename(parent, name, newparent, newname, flags, reply)
    }
} 