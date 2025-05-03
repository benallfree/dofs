pub mod memory;

use fuser::{Request, ReplyAttr, ReplyEntry, ReplyDirectory, ReplyData, ReplyCreate, ReplyWrite};
use std::ffi::OsStr;

pub trait Provider {
    fn rmdir(&mut self, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty);
    fn open(&mut self, ino: u64, reply: fuser::ReplyOpen);
    fn flush(&mut self, ino: u64, reply: fuser::ReplyEmpty);
    fn release(&mut self, ino: u64, reply: fuser::ReplyEmpty);
    fn setattr(&mut self, ino: u64, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>, atime: Option<fuser::TimeOrNow>, mtime: Option<fuser::TimeOrNow>, ctime: Option<std::time::SystemTime>, crtime: Option<std::time::SystemTime>, flags: Option<u32>, reply: ReplyAttr);
    fn lookup(&mut self, parent: u64, name: &OsStr, reply: ReplyEntry);
    fn getattr(&mut self, ino: u64, reply: ReplyAttr);
    fn readdir(&mut self, ino: u64, offset: i64, reply: ReplyDirectory);
    fn mkdir(&mut self, parent: u64, name: &OsStr, mode: u32, umask: u32, reply: ReplyEntry);
    fn create(&mut self, parent: u64, name: &OsStr, mode: u32, flags: u32, umask: i32, reply: ReplyCreate);
    fn read(&mut self, ino: u64, offset: i64, size: u32, reply: ReplyData);
    fn write(&mut self, ino: u64, offset: i64, data: &[u8], reply: ReplyWrite);
} 