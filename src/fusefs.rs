use fuser::{Filesystem, Request, ReplyAttr, ReplyEntry, ReplyDirectory, ReplyData, ReplyCreate, ReplyWrite};
use crate::providers::Provider;
use std::ffi::OsStr;

pub struct FuseFS {
    pub provider: Box<dyn Provider + Send>,
}

impl FuseFS {
    pub fn new(provider: Box<dyn Provider + Send>) -> Self {
        Self { provider }
    }
}

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
    fn setattr(&mut self, _req: &Request<'_>, ino: u64, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, atime: Option<fuser::TimeOrNow>, mtime: Option<fuser::TimeOrNow>, ctime: Option<std::time::SystemTime>, fh: Option<u64>, crtime: Option<std::time::SystemTime>, chgtime: Option<std::time::SystemTime>, bkuptime: Option<std::time::SystemTime>, flags: Option<u32>, reply: ReplyAttr) {
        self.provider.setattr(ino, mode, uid, gid, size, atime, mtime, ctime, crtime, flags, reply)
    }
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        self.provider.lookup(parent, name, reply)
    }
    fn getattr(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyAttr) {
        self.provider.getattr(ino, reply)
    }
    fn readdir(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        self.provider.readdir(ino, offset, reply)
    }
    fn mkdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, umask: u32, reply: ReplyEntry) {
        self.provider.mkdir(parent, name, mode, umask, reply)
    }
    fn create(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, flags: u32, umask: i32, reply: ReplyCreate) {
        self.provider.create(parent, name, mode, flags, umask, reply)
    }
    fn read(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, size: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyData) {
        self.provider.read(ino, offset, size, reply)
    }
    fn write(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, data: &[u8], _write_flags: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyWrite) {
        self.provider.write(ino, offset, data, reply)
    }
    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        self.provider.unlink(parent, name, reply)
    }
} 