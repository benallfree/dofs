import { DurableObject } from 'cloudflare:workers'

export type ReadFileOptions = { encoding?: string }
export type WriteFileOptions = { encoding?: string }
export type ReadOptions = { offset?: number; length?: number; encoding?: string }
export type WriteOptions = { offset?: number; encoding?: string }
export type MkdirOptions = { recursive?: boolean }
export type RmdirOptions = { recursive?: boolean }
export type ListDirOptions = { recursive?: boolean }
export type SetAttrOptions = { mode?: number; uid?: number; gid?: number }
export type Stat = {
  isFile: boolean
  isDirectory: boolean
  size: number
  mode?: number
  uid?: number
  gid?: number
  mtime?: number
  ctime?: number
}

interface FilesystemAPI {
  readFile(path: string, options?: ReadFileOptions): ArrayBuffer | string
  writeFile(path: string, data: ArrayBuffer | string, options?: WriteFileOptions): void
  read(path: string, options: ReadOptions): ArrayBuffer | string
  write(path: string, data: ArrayBuffer | string, options: WriteOptions): void
  mkdir(path: string, options?: MkdirOptions): void
  rmdir(path: string, options?: RmdirOptions): void
  listDir(path: string, options?: ListDirOptions): string[]
  stat(path: string): Stat
  setattr(path: string, options: SetAttrOptions): void
  symlink(target: string, path: string): void
  readlink(path: string): string
  rename(oldPath: string, newPath: string): void
  unlink(path: string): void
}

type DurableObjectFsStorage = DurableObject['ctx']['storage'] & {
  fs: FilesystemAPI
}

type DurableObjectFsState = DurableObject['ctx'] & {
  storage: DurableObjectFsStorage
}

export class DurableObjectFs<Env = unknown> extends DurableObject<Env> {
  protected ctx: DurableObjectFsState

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx = ctx as DurableObjectFsState
    this.ensureSchema()
    this.mountFsApi()
  }

  private mountFsApi() {
    this.ctx.storage.fs = {
      readFile: (path: string, options?: ReadFileOptions) => {
        const ino = this.resolvePathToInode(path)
        const cursor = this.ctx.storage.sql.exec(
          'SELECT offset, data, length FROM chunks WHERE ino = ? ORDER BY offset ASC',
          ino
        )
        let chunks: Uint8Array[] = []
        let total = 0
        for (let row of cursor) {
          if (row.data && (row.data instanceof ArrayBuffer || ArrayBuffer.isView(row.data))) {
            const arr = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data.buffer)
            chunks.push(arr)
            total += arr.length
          }
        }
        const result = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.length
        }
        return result.buffer
      },
      writeFile: (path: string, data: ArrayBuffer | string, options?: WriteFileOptions) => {
        const ino = this.resolvePathToInode(path)
        this.ctx.storage.sql.exec('DELETE FROM chunks WHERE ino = ?', ino)
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.ctx.storage.sql.exec(
          'INSERT INTO chunks (ino, offset, data, length) VALUES (?, ?, ?, ?)',
          ino,
          0,
          buf,
          buf.length
        )
      },
      read: (path: string, options: ReadOptions) => {
        const ino = this.resolvePathToInode(path)
        const offset = options?.offset ?? 0
        const length = options?.length ?? undefined
        const cursor = this.ctx.storage.sql.exec(
          'SELECT offset, data, length FROM chunks WHERE ino = ? ORDER BY offset ASC',
          ino
        )
        let chunks: { offset: number; data: Uint8Array }[] = []
        let fileEnd = 0
        for (let row of cursor) {
          if (row.data && (row.data instanceof ArrayBuffer || ArrayBuffer.isView(row.data))) {
            const arr = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data.buffer)
            chunks.push({ offset: Number(row.offset), data: arr })
            fileEnd = Math.max(fileEnd, Number(row.offset) + arr.length)
          }
        }
        const end = length !== undefined ? offset + length : fileEnd
        const result = new Uint8Array(end - offset)
        for (const chunk of chunks) {
          const chunkStart = chunk.offset
          const chunkEnd = chunk.offset + chunk.data.length
          const readStart = Math.max(offset, chunkStart)
          const readEnd = Math.min(end, chunkEnd)
          if (readStart < readEnd) {
            const destStart = readStart - offset
            const srcStart = readStart - chunkStart
            const len = readEnd - readStart
            result.set(chunk.data.subarray(srcStart, srcStart + len), destStart)
          }
        }
        return result.buffer
      },
      write: (path: string, data: ArrayBuffer | string, options: WriteOptions) => {
        const ino = this.resolvePathToInode(path)
        const offset = options?.offset ?? 0
        this.ctx.storage.sql.exec('DELETE FROM chunks WHERE ino = ?', ino)
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.ctx.storage.sql.exec(
          'INSERT INTO chunks (ino, offset, data, length) VALUES (?, ?, ?, ?)',
          ino,
          offset,
          buf,
          buf.length
        )
      },
      mkdir: (path: string, options?: MkdirOptions) => {
        const parts = path.split('/').filter(Boolean)
        if (parts.length === 0) throw new Error('EEXIST')
        const name = parts[parts.length - 1]
        const parentPath = '/' + parts.slice(0, -1).join('/')
        const parent = this.resolvePathToInode(parentPath)
        // Check if already exists
        const cursor = this.ctx.storage.sql.exec('SELECT ino FROM files WHERE parent = ? AND name = ?', parent, name)
        if (cursor.next().value) throw new Error('EEXIST')
        const ino = this.allocInode()
        const now = Date.now()
        const attr = {
          ino,
          size: 0,
          blocks: 0,
          atime: now,
          mtime: now,
          ctime: now,
          crtime: now,
          kind: 'Directory',
          perm: 0o755,
          nlink: 2,
          uid: 0,
          gid: 0,
          rdev: 0,
          flags: 0,
          blksize: 512,
        }
        this.ctx.storage.sql.exec(
          'INSERT INTO files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, NULL)',
          ino,
          name,
          parent,
          1,
          JSON.stringify(attr)
        )
      },
      rmdir: (path: string, options?: RmdirOptions) => {
        const ino = this.resolvePathToInode(path)
        const cursor = this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM files WHERE parent = ?', ino)
        const row = cursor.next().value
        if (!row) throw new Error('ENOENT')
        if (Number(row.count) > 0) throw new Error('ENOTEMPTY')
        this.ctx.storage.sql.exec('DELETE FROM files WHERE ino = ?', ino)
      },
      listDir: (path: string, options?: ListDirOptions) => {
        const ino = this.resolvePathToInode(path)
        const cursor = this.ctx.storage.sql.exec('SELECT name FROM files WHERE parent = ?', ino)
        const names: string[] = []
        for (let row of cursor) {
          if (typeof row.name === 'string') names.push(row.name)
        }
        return names
      },
      stat: (path: string) => {
        const ino = this.resolvePathToInode(path)
        const cursor = this.ctx.storage.sql.exec('SELECT attr, is_dir FROM files WHERE ino = ?', ino)
        const row = cursor.next().value
        if (!row) throw new Error('ENOENT')
        const attr = typeof row.attr === 'string' ? JSON.parse(row.attr) : row.attr
        return {
          isFile: !row.is_dir,
          isDirectory: !!row.is_dir,
          size: attr.size,
          mode: attr.perm,
          uid: attr.uid,
          gid: attr.gid,
          mtime: attr.mtime,
          ctime: attr.ctime,
        }
      },
      setattr: (path: string, options: SetAttrOptions) => {
        const ino = this.resolvePathToInode(path)
        const cursor = this.ctx.storage.sql.exec('SELECT attr FROM files WHERE ino = ?', ino)
        const row = cursor.next().value
        if (!row) throw new Error('ENOENT')
        const attr = typeof row.attr === 'string' ? JSON.parse(row.attr) : row.attr
        if (options.mode !== undefined) attr.perm = options.mode
        if (options.uid !== undefined) attr.uid = options.uid
        if (options.gid !== undefined) attr.gid = options.gid
        this.ctx.storage.sql.exec('UPDATE files SET attr = ? WHERE ino = ?', JSON.stringify(attr), ino)
      },
      symlink: (target: string, path: string) => {
        const parts = path.split('/').filter(Boolean)
        if (parts.length === 0) throw new Error('EEXIST')
        const name = parts[parts.length - 1]
        const parentPath = '/' + parts.slice(0, -1).join('/')
        const parent = this.resolvePathToInode(parentPath)
        // Check if already exists
        const cursor = this.ctx.storage.sql.exec('SELECT ino FROM files WHERE parent = ? AND name = ?', parent, name)
        if (cursor.next().value) throw new Error('EEXIST')
        const ino = this.allocInode()
        const now = Date.now()
        const attr = {
          ino,
          size: target.length,
          blocks: 0,
          atime: now,
          mtime: now,
          ctime: now,
          crtime: now,
          kind: 'Symlink',
          perm: 0o777,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          flags: 0,
          blksize: 512,
        }
        const data = new TextEncoder().encode(target)
        this.ctx.storage.sql.exec(
          'INSERT INTO files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, ?)',
          ino,
          name,
          parent,
          0,
          JSON.stringify(attr),
          data
        )
      },
      readlink: (path: string) => {
        const ino = this.resolvePathToInode(path)
        const cursor = this.ctx.storage.sql.exec('SELECT data FROM files WHERE ino = ?', ino)
        const row = cursor.next().value
        if (!row || !row.data) throw new Error('ENOENT')
        let arr: Uint8Array
        if (row.data instanceof ArrayBuffer) {
          arr = new Uint8Array(row.data)
        } else if (ArrayBuffer.isView(row.data)) {
          arr = new Uint8Array(row.data.buffer)
        } else {
          throw new Error('ENOENT')
        }
        return new TextDecoder().decode(arr)
      },
      rename: (oldPath: string, newPath: string) => {
        const oldParts = oldPath.split('/').filter(Boolean)
        const newParts = newPath.split('/').filter(Boolean)
        if (oldParts.length === 0 || newParts.length === 0) throw new Error('ENOENT')
        const oldName = oldParts[oldParts.length - 1]
        const oldParentPath = '/' + oldParts.slice(0, -1).join('/')
        const newName = newParts[newParts.length - 1]
        const newParentPath = '/' + newParts.slice(0, -1).join('/')
        const oldParent = this.resolvePathToInode(oldParentPath)
        const newParent = this.resolvePathToInode(newParentPath)
        const oldCursor = this.ctx.storage.sql.exec(
          'SELECT ino FROM files WHERE parent = ? AND name = ?',
          oldParent,
          oldName
        )
        const oldRow = oldCursor.next().value
        if (!oldRow) throw new Error('ENOENT')
        const ino = oldRow.ino
        // If destination exists, delete it
        const newCursor = this.ctx.storage.sql.exec(
          'SELECT ino FROM files WHERE parent = ? AND name = ?',
          newParent,
          newName
        )
        const newRow = newCursor.next().value
        if (newRow) {
          this.ctx.storage.sql.exec('DELETE FROM files WHERE ino = ?', newRow.ino)
          this.ctx.storage.sql.exec('DELETE FROM chunks WHERE ino = ?', newRow.ino)
        }
        this.ctx.storage.sql.exec('UPDATE files SET parent = ?, name = ? WHERE ino = ?', newParent, newName, ino)
      },
      unlink: (path: string) => {
        const ino = this.resolvePathToInode(path)
        this.ctx.storage.sql.exec('DELETE FROM files WHERE ino = ?', ino)
        this.ctx.storage.sql.exec('DELETE FROM chunks WHERE ino = ?', ino)
      },
    }
  }

  private rootDirAttr() {
    const now = Date.now()
    return {
      ino: 1,
      size: 0,
      blocks: 0,
      atime: now,
      mtime: now,
      ctime: now,
      crtime: now,
      kind: 'Directory',
      perm: 0o755,
      nlink: 2,
      uid: 0,
      gid: 0,
      rdev: 0,
      flags: 0,
      blksize: 512,
    }
  }

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS files (
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
			CREATE INDEX IF NOT EXISTS idx_chunks_ino_offset ON chunks(ino, offset);
		`)

    // Ensure root exists
    const cursor = this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM files WHERE ino = ?', 1)
    const row = cursor.next().value
    if (!row || row.count === 0) {
      const attr = this.rootDirAttr()
      this.ctx.storage.sql.exec(
        'INSERT INTO files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, NULL)',
        1,
        '/',
        undefined,
        1,
        JSON.stringify(attr)
      )
    }
  }

  // Add a sync version of resolvePathToInode for use in sync methods
  private resolvePathToInode(path: string): number {
    if (path === '/' || path === '') return 1
    const parts = path.split('/').filter(Boolean)
    let parent = 1
    for (const name of parts) {
      const cursor = this.ctx.storage.sql.exec('SELECT ino FROM files WHERE parent = ? AND name = ?', parent, name)
      const row = cursor.next().value
      if (!row || row.ino == null) throw new Error('ENOENT')
      parent = Number(row.ino)
    }
    return parent
  }

  // Add a sync version of allocInode for use in sync methods
  private allocInode(): number {
    const cursor = this.ctx.storage.sql.exec('SELECT MAX(ino) as max FROM files')
    const row = cursor.next().value
    return row && row.max != null ? Number(row.max) + 1 : 2
  }
}
