interface FilesystemAPI {
  readFile(path: string, options?: ReadFileOptions): Promise<Buffer | string>
  writeFile(
    path: string,
    data: Buffer | string,
    options?: WriteFileOptions
  ): Promise<void>
  read(path: string, options: ReadOptions): Promise<Buffer | string>
  write(
    path: string,
    data: Buffer | string,
    options: WriteOptions
  ): Promise<void>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rmdir(path: string, options?: RmdirOptions): Promise<void>
  listDir(path: string, options?: ListDirOptions): Promise<string[]>
  stat(path: string): Promise<Stat>
  setattr(path: string, options: SetAttrOptions): Promise<void>
  symlink(target: string, path: string): Promise<void>
  readlink(path: string): Promise<string>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

// 1. Create a directory
await ctx.storage.fs.mkdir('/notes')

// 2. Write a new file
await ctx.storage.fs.writeFile('/notes/todo.txt', 'Buy milk', {
  encoding: 'utf8',
})

// 3. Read the file as a string
const todo = await ctx.storage.fs.readFile('/notes/todo.txt', {
  encoding: 'utf8',
})
// todo: string = "Buy milk"

// 4. Append to the file using random write
await ctx.storage.fs.write('/notes/todo.txt', '\nCall Alice', {
  offset: 8,
  encoding: 'utf8',
})

// 5. Read a portion of the file (random read)
const partial = await ctx.storage.fs.read('/notes/todo.txt', {
  offset: 4,
  length: 4,
  encoding: 'utf8',
})
// partial: string = "milk"

// 6. List files in the directory
const files = await ctx.storage.fs.listDir('/notes')
// files: string[] = ["todo.txt"]

// 7. Get file metadata
const stats = await ctx.storage.fs.stat('/notes/todo.txt')
// stats: Stat = { isFile: true, isDirectory: false, size: ..., ... }

// 8. Change file permissions and owner
await ctx.storage.fs.setattr('/notes/todo.txt', {
  mode: 0o600,
  uid: 1001,
  gid: 1001,
})

// 9. Create a symlink
await ctx.storage.fs.symlink('/notes/todo.txt', '/notes/todo-link')

// 10. Read the symlink target
const linkTarget = await ctx.storage.fs.readlink('/notes/todo-link')
// linkTarget: string = "/notes/todo.txt"

// 11. Rename the file
await ctx.storage.fs.rename('/notes/todo.txt', '/notes/tasks.txt')

// 12. Delete the symlink
await ctx.storage.fs.unlink('/notes/todo-link')

// 13. Delete the file
await ctx.storage.fs.unlink('/notes/tasks.txt')

// 14. Remove the directory
await ctx.storage.fs.rmdir('/notes')
