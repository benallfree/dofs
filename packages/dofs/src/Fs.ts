export type CreateOptions = { mode?: number; umask?: number }
export type DeviceStats = {
  deviceSize: number
  spaceUsed: number
  spaceAvailable: number
}
export type ReadFileOptions = { encoding?: string }
export type WriteFileOptions = { encoding?: string }
export type ReadOptions = { offset?: number; length?: number; encoding?: string }
export type WriteOptions = { offset?: number; encoding?: string }
export type MkdirOptions = { recursive?: boolean } & CreateOptions
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
  atime?: number
  crtime?: number
  blocks?: number
  nlink?: number
  rdev?: number
  flags?: number
  blksize?: number
  kind?: string
}

export type FsOptions = {
  chunkSize?: number
}

export class Fs {
  protected ctx: DurableObjectState
  protected env: Env
  protected chunkSize: number

  constructor(ctx: DurableObjectState, env: Env, options?: FsOptions) {
    this.env = env
    this.ctx = ctx
    this.chunkSize = options?.chunkSize ?? 4096 // 4kb
    this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema()
    })
  }

  public readFile(path: string, options?: ReadFileOptions) {
    const ino = this.resolvePathToInode(path)
    // Get file size
    const statCursor = this.ctx.storage.sql.exec('SELECT attr FROM dofs_files WHERE ino = ?', ino)
    const statRow = statCursor.next().value
    if (!statRow || !statRow.attr) throw new Error('ENOENT')
    const attr = typeof statRow.attr === 'string' ? JSON.parse(statRow.attr) : statRow.attr
    const fileSize = attr.size || 0
    let currentOffset = 0
    const self = this
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        console.log('pull', { currentOffset, fileSize })
        if (currentOffset >= fileSize) {
          controller.close()
          return
        }
        const readLength = Math.min(self.chunkSize, fileSize - currentOffset)
        // Read chunk from DB
        const chunkCursor = self.ctx.storage.sql.exec(
          'SELECT data FROM dofs_chunks WHERE ino = ? AND offset = ? LIMIT 1',
          ino,
          currentOffset
        )
        const chunkRow = chunkCursor.next().value
        let chunk: Uint8Array
        if (chunkRow && chunkRow.data) {
          if (chunkRow.data instanceof ArrayBuffer) {
            chunk = new Uint8Array(chunkRow.data)
          } else if (ArrayBuffer.isView(chunkRow.data)) {
            chunk = new Uint8Array(chunkRow.data.buffer)
          } else if (typeof chunkRow.data === 'string') {
            chunk = Uint8Array.from(chunkRow.data)
          } else {
            chunk = new Uint8Array(0)
          }
        } else {
          chunk = new Uint8Array(0)
        }
        console.log('chunk', { chunk })
        controller.enqueue(chunk)
        currentOffset += readLength
      },
    })
  }

  public async writeFile(
    path: string,
    data: ArrayBuffer | string | ReadableStream<Uint8Array>,
    options?: WriteFileOptions
  ) {
    // Try to unlink if exists
    try {
      this.unlink(path)
    } catch (e: any) {
      if (!(e instanceof Error && e.message === 'ENOENT')) throw e
    }
    // Check available space before creating
    const deviceSize = this.getDeviceSize()
    const spaceUsed = this.getSpaceUsed()
    // Create the file
    this.create(path)
    // Handle streaming upload
    if (typeof data === 'object' && data !== null && typeof (data as any).getReader === 'function') {
      // Stream case
      const CHUNK_SIZE = 1024 * 1024 // 1MB
      let offset = 0
      let total = 0
      const reader = (data as ReadableStream<Uint8Array>).getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        if (spaceUsed + total + value.length > deviceSize) {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        }
        // Write chunk
        this.write(path, value, { offset, encoding: options?.encoding })
        offset += value.length
        total += value.length
      }
      return
    }
    // Buffer or string case
    if (typeof data === 'string') {
      const buf = new TextEncoder().encode(data)
      if (spaceUsed + buf.length > deviceSize) {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
      this.write(path, buf, { offset: 0, encoding: options?.encoding })
      return
    }
    if (data instanceof ArrayBuffer) {
      const buf = new Uint8Array(data)
      if (spaceUsed + buf.length > deviceSize) {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
      this.write(path, buf, { offset: 0, encoding: options?.encoding })
      return
    }
    if (ArrayBuffer.isView(data)) {
      const buf = new Uint8Array(data.buffer)
      if (spaceUsed + buf.length > deviceSize) {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
      this.write(path, buf, { offset: 0, encoding: options?.encoding })
      return
    }
    throw new Error('Unsupported data type for writeFile')
  }

  public read(path: string, options: ReadOptions) {
    const ino = this.resolvePathToInode(path)
    const offset = options?.offset ?? 0
    const length = options?.length ?? undefined
    const cursor = this.ctx.storage.sql.exec(
      'SELECT offset, data, length FROM dofs_chunks WHERE ino = ? ORDER BY offset ASC',
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
  }

  public write(path: string, data: ArrayBuffer | string, options: WriteOptions) {
    let ino: number
    try {
      ino = this.resolvePathToInode(path)
    } catch (e: any) {
      if (e instanceof Error && e.message === 'ENOENT') {
        this.create(path)
        ino = this.resolvePathToInode(path)
      } else {
        throw e
      }
    }
    const offset = options?.offset ?? 0
    const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    // Check available space
    const deviceSize = this.getDeviceSize()
    const spaceUsed = this.getSpaceUsed()
    // Estimate new space needed: sum of new data written beyond current file size
    const fileCursor = this.ctx.storage.sql.exec('SELECT attr FROM dofs_files WHERE ino = ?', ino)
    const fileRow = fileCursor.next().value
    let fileSize = 0
    if (fileRow && fileRow.attr) {
      const attr = typeof fileRow.attr === 'string' ? JSON.parse(fileRow.attr) : fileRow.attr
      fileSize = attr.size || 0
    }
    const endOffset = offset + buf.length
    const additional = endOffset > fileSize ? endOffset - fileSize : 0
    if (spaceUsed + additional > deviceSize) {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    }
    const CHUNK_SIZE = this.chunkSize
    let written = 0
    let maxEnd = 0
    while (written < buf.length) {
      const absOffset = offset + written
      const chunkIdx = Math.floor(absOffset / CHUNK_SIZE)
      const chunkOffset = chunkIdx * CHUNK_SIZE
      const chunkOffInChunk = absOffset % CHUNK_SIZE
      const writeLen = Math.min(CHUNK_SIZE - chunkOffInChunk, buf.length - written)
      // Use helper to load chunk
      let chunkData = this.loadChunk(ino, chunkOffset, CHUNK_SIZE)
      chunkData.set(buf.subarray(written, written + writeLen), chunkOffInChunk)
      // Calculate chunk length (last chunk may be partial)
      let chunkLength = CHUNK_SIZE
      const thisEnd = chunkOffInChunk + writeLen
      if (thisEnd < CHUNK_SIZE) {
        chunkLength = thisEnd
      }
      // Upsert chunk
      this.ctx.storage.sql.exec(
        'INSERT INTO dofs_chunks (ino, offset, data, length) VALUES (?, ?, ?, ?) ON CONFLICT(ino, offset) DO UPDATE SET data=excluded.data, length=excluded.length',
        ino,
        chunkOffset,
        chunkData.subarray(0, chunkLength),
        chunkLength
      )
      written += writeLen
      maxEnd = Math.max(maxEnd, absOffset + writeLen)
    }
    // Update file size and space used
    this.updateFileSizeAndSpaceUsed(ino)
  }

  public mkdir(path: string, options?: MkdirOptions) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    const name = parts[parts.length - 1]
    const parentPath = '/' + parts.slice(0, -1).join('/')
    const parent = this.resolvePathToInode(parentPath)
    // Check if already exists
    const cursor = this.ctx.storage.sql.exec('SELECT ino FROM dofs_files WHERE parent = ? AND name = ?', parent, name)
    if (cursor.next().value) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    const ino = this.allocInode()
    const now = Date.now()
    const mode = options?.mode ?? 0o755
    const umask = options?.umask ?? 0
    const perm = mode & ~umask & 0o7777
    const attr = {
      ino,
      size: 0,
      blocks: 0,
      atime: now,
      mtime: now,
      ctime: now,
      crtime: now,
      kind: 'Directory',
      perm,
      nlink: 2,
      uid: 0,
      gid: 0,
      rdev: 0,
      flags: 0,
      blksize: 512,
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO dofs_files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, NULL)',
      ino,
      name,
      parent,
      1,
      JSON.stringify(attr)
    )
  }

  public rmdir(path: string, options?: RmdirOptions) {
    const ino = this.resolvePathToInode(path)
    const cursor = this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM dofs_files WHERE parent = ?', ino)
    const row = cursor.next().value
    if (!row) throw new Error('ENOENT')
    if (Number(row.count) > 0) throw new Error('ENOTEMPTY')
    this.ctx.storage.sql.exec('DELETE FROM dofs_files WHERE ino = ?', ino)
  }

  public listDir(path: string, options?: ListDirOptions) {
    const ino = this.resolvePathToInode(path)
    const cursor = this.ctx.storage.sql.exec('SELECT name FROM dofs_files WHERE parent = ?', ino)
    const names: string[] = ['.', '..']
    for (let row of cursor) {
      if (typeof row.name === 'string') names.push(row.name)
    }
    return names
  }

  public stat(path: string): Stat {
    const ino = this.resolvePathToInode(path)
    const cursor = this.ctx.storage.sql.exec('SELECT attr, is_dir FROM dofs_files WHERE ino = ?', ino)
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
      atime: attr.atime,
      crtime: attr.crtime,
      blocks: attr.blocks,
      nlink: attr.nlink,
      rdev: attr.rdev,
      flags: attr.flags,
      blksize: attr.blksize,
      kind: attr.kind,
    }
  }

  public setattr(path: string, options: SetAttrOptions) {
    const ino = this.resolvePathToInode(path)
    const cursor = this.ctx.storage.sql.exec('SELECT attr FROM dofs_files WHERE ino = ?', ino)
    const row = cursor.next().value
    if (!row) throw new Error('ENOENT')
    const attr = typeof row.attr === 'string' ? JSON.parse(row.attr) : row.attr
    if (options.mode !== undefined) attr.perm = options.mode
    if (options.uid !== undefined) attr.uid = options.uid
    if (options.gid !== undefined) attr.gid = options.gid
    this.ctx.storage.sql.exec('UPDATE dofs_files SET attr = ? WHERE ino = ?', JSON.stringify(attr), ino)
  }

  public symlink(target: string, path: string) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) throw new Error('EEXIST')
    const name = parts[parts.length - 1]
    const parentPath = '/' + parts.slice(0, -1).join('/')
    const parent = this.resolvePathToInode(parentPath)
    // Check if already exists
    const cursor = this.ctx.storage.sql.exec('SELECT ino FROM dofs_files WHERE parent = ? AND name = ?', parent, name)
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
      'INSERT INTO dofs_files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, ?)',
      ino,
      name,
      parent,
      0,
      JSON.stringify(attr),
      data
    )
  }

  public readlink(path: string) {
    const ino = this.resolvePathToInode(path)
    const cursor = this.ctx.storage.sql.exec('SELECT data FROM dofs_files WHERE ino = ?', ino)
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
  }

  public rename(oldPath: string, newPath: string) {
    const oldParts = oldPath.split('/').filter(Boolean)
    const newParts = newPath.split('/').filter(Boolean)
    if (oldParts.length === 0 || newParts.length === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const oldName = oldParts[oldParts.length - 1]
    const oldParentPath = '/' + oldParts.slice(0, -1).join('/')
    const newName = newParts[newParts.length - 1]
    const newParentPath = '/' + newParts.slice(0, -1).join('/')
    const oldParent = this.resolvePathToInode(oldParentPath)
    const newParent = this.resolvePathToInode(newParentPath)
    const oldCursor = this.ctx.storage.sql.exec(
      'SELECT ino FROM dofs_files WHERE parent = ? AND name = ?',
      oldParent,
      oldName
    )
    const oldRow = oldCursor.next().value
    if (!oldRow) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const ino = oldRow.ino
    // If destination exists, check if it's a non-empty directory
    const newCursor = this.ctx.storage.sql.exec(
      'SELECT ino, is_dir FROM dofs_files WHERE parent = ? AND name = ?',
      newParent,
      newName
    )
    const newRow = newCursor.next().value
    if (newRow) {
      if (newRow.is_dir) {
        const childCursor = this.ctx.storage.sql.exec(
          'SELECT COUNT(*) as count FROM dofs_files WHERE parent = ?',
          newRow.ino
        )
        const childRow = childCursor.next().value
        if (childRow && Number(childRow.count) > 0) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
      }
      this.ctx.storage.sql.exec('DELETE FROM dofs_files WHERE ino = ?', newRow.ino)
      this.ctx.storage.sql.exec('DELETE FROM dofs_chunks WHERE ino = ?', newRow.ino)
    }
    this.ctx.storage.sql.exec('UPDATE dofs_files SET parent = ?, name = ? WHERE ino = ?', newParent, newName, ino)
  }

  public unlink(path: string) {
    const ino = this.resolvePathToInode(path)
    const cursor = this.ctx.storage.sql.exec('SELECT is_dir FROM dofs_files WHERE ino = ?', ino)
    const row = cursor.next().value
    if (!row) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (row.is_dir) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
    this.ctx.storage.sql.exec('DELETE FROM dofs_files WHERE ino = ?', ino)
    this.ctx.storage.sql.exec('DELETE FROM dofs_chunks WHERE ino = ?', ino)
    // Update space used
    this.updateFileSizeAndSpaceUsed(ino)
  }

  public create(path: string, options?: CreateOptions) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    const name = parts[parts.length - 1]
    const parentPath = '/' + parts.slice(0, -1).join('/')
    const parent = this.resolvePathToInode(parentPath)
    // Check if already exists
    const cursor = this.ctx.storage.sql.exec('SELECT ino FROM dofs_files WHERE parent = ? AND name = ?', parent, name)
    if (cursor.next().value) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    const ino = this.allocInode()
    const now = Date.now()
    const mode = options?.mode ?? 0o644
    const umask = options?.umask ?? 0
    const perm = mode & ~umask & 0o7777
    const attr = {
      ino,
      size: 0,
      blocks: 0,
      atime: now,
      mtime: now,
      ctime: now,
      crtime: now,
      kind: 'File',
      perm,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      flags: 0,
      blksize: 512,
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO dofs_files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, NULL)',
      ino,
      name,
      parent,
      0,
      JSON.stringify(attr)
    )
  }

  public truncate(path: string, size: number) {
    const ino = this.resolvePathToInode(path)
    const CHUNK_SIZE = this.chunkSize
    // Delete all chunks past the new size
    const firstExcessChunk = Math.floor(size / CHUNK_SIZE) * CHUNK_SIZE
    this.ctx.storage.sql.exec('DELETE FROM dofs_chunks WHERE ino = ? AND offset >= ?', ino, firstExcessChunk)
    // If the last chunk is partial, trim it
    if (size % CHUNK_SIZE !== 0) {
      const lastChunkOffset = Math.floor(size / CHUNK_SIZE) * CHUNK_SIZE
      const lastLen = size % CHUNK_SIZE
      // Use helper to load chunk
      let chunkData = this.loadChunk(ino, lastChunkOffset, CHUNK_SIZE)
      chunkData = chunkData.subarray(0, lastLen)
      this.ctx.storage.sql.exec(
        'UPDATE dofs_chunks SET data = ?, length = ? WHERE ino = ? AND offset = ?',
        chunkData,
        lastLen,
        ino,
        lastChunkOffset
      )
    }
    // Update file size and space used
    this.updateFileSizeAndSpaceUsed(ino)
  }

  public getDeviceStats(): DeviceStats {
    const size = this.getDeviceSize()
    const used = this.getSpaceUsed()
    return {
      deviceSize: size,
      spaceUsed: used,
      spaceAvailable: size - used,
    }
  }

  public setDeviceSize(newSize: number) {
    const used = this.getSpaceUsed()
    if (newSize < used) {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    }
    this.ctx.storage.sql.exec('UPDATE dofs_meta SET value = ? WHERE key = ?', newSize.toString(), 'device_size')
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
      CREATE TABLE IF NOT EXISTS dofs_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS dofs_files (
        ino INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        parent INTEGER,
        is_dir INTEGER NOT NULL,
        attr BLOB,
        data BLOB
      );
      CREATE TABLE IF NOT EXISTS dofs_chunks (
        ino INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        data BLOB NOT NULL,
        length INTEGER NOT NULL,
        PRIMARY KEY (ino, offset)
      );
      CREATE INDEX IF NOT EXISTS idx_dofs_files_parent_name ON dofs_files(parent, name);
      CREATE INDEX IF NOT EXISTS idx_dofs_files_parent ON dofs_files(parent);
      CREATE INDEX IF NOT EXISTS idx_dofs_files_name ON dofs_files(name);
      CREATE INDEX IF NOT EXISTS idx_dofs_chunks_ino ON dofs_chunks(ino);
      CREATE INDEX IF NOT EXISTS idx_dofs_chunks_ino_offset ON dofs_chunks(ino, offset);
    `)

    // Ensure meta row exists
    const metaCursor = this.ctx.storage.sql.exec('SELECT value FROM dofs_meta WHERE key = ?', 'device_size')
    if (!metaCursor.next().value) {
      this.ctx.storage.sql.exec(
        'INSERT INTO dofs_meta (key, value) VALUES (?, ?)',
        'device_size',
        (1024 * 1024 * 1024).toString()
      )
    }
    const usedCursor = this.ctx.storage.sql.exec('SELECT value FROM dofs_meta WHERE key = ?', 'space_used')
    if (!usedCursor.next().value) {
      this.ctx.storage.sql.exec('INSERT INTO dofs_meta (key, value) VALUES (?, ?)', 'space_used', '0')
    }

    // Ensure root exists
    const cursor = this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM dofs_files WHERE ino = ?', 1)
    const row = cursor.next().value
    if (!row || row.count === 0) {
      const attr = this.rootDirAttr()
      this.ctx.storage.sql.exec(
        'INSERT INTO dofs_files (ino, name, parent, is_dir, attr, data) VALUES (?, ?, ?, ?, ?, NULL)',
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
      const cursor = this.ctx.storage.sql.exec('SELECT ino FROM dofs_files WHERE parent = ? AND name = ?', parent, name)
      const row = cursor.next().value
      if (!row || row.ino == null) throw new Error('ENOENT')
      parent = Number(row.ino)
    }
    return parent
  }

  // Add a sync version of allocInode for use in sync methods
  private allocInode(): number {
    const cursor = this.ctx.storage.sql.exec('SELECT MAX(ino) as max FROM dofs_files')
    const row = cursor.next().value
    return row && row.max != null ? Number(row.max) + 1 : 2
  }

  // Helper to load a chunk as Uint8Array, or zero-filled if not present
  private loadChunk(ino: number, chunkOffset: number, chunkSize: number): Uint8Array {
    const chunkCursor = this.ctx.storage.sql.exec(
      'SELECT data FROM dofs_chunks WHERE ino = ? AND offset = ?',
      ino,
      chunkOffset
    )
    const chunkRow = chunkCursor.next().value
    if (chunkRow && chunkRow.data) {
      if (chunkRow.data instanceof ArrayBuffer) {
        return new Uint8Array(chunkRow.data)
      } else if (ArrayBuffer.isView(chunkRow.data)) {
        return new Uint8Array(chunkRow.data.buffer)
      }
    }
    return new Uint8Array(chunkSize)
  }

  // Helper to get/set device size and space used
  private getDeviceSize(): number {
    const cursor = this.ctx.storage.sql.exec('SELECT value FROM dofs_meta WHERE key = ?', 'device_size')
    const row = cursor.next().value
    return row ? Number(row.value) : 1024 * 1024 * 1024
  }
  private getSpaceUsed(): number {
    const cursor = this.ctx.storage.sql.exec('SELECT value FROM dofs_meta WHERE key = ?', 'space_used')
    const row = cursor.next().value
    return row ? Number(row.value) : 0
  }
  private setSpaceUsed(val: number) {
    this.ctx.storage.sql.exec('UPDATE dofs_meta SET value = ? WHERE key = ?', val.toString(), 'space_used')
  }
  private updateFileSizeAndSpaceUsed(ino: number) {
    // Sum all chunk lengths for this ino
    const cursor = this.ctx.storage.sql.exec('SELECT SUM(length) as total FROM dofs_chunks WHERE ino = ?', ino)
    const row = cursor.next().value
    const size = row && row.total ? Number(row.total) : 0
    // Update file attr
    this.ctx.storage.sql.exec('UPDATE dofs_files SET attr = json_set(attr, "$.size", ?) WHERE ino = ?', size, ino)
    // Update space_used (sum all chunk lengths for all files)
    const usedCursor = this.ctx.storage.sql.exec('SELECT SUM(length) as total FROM dofs_chunks')
    const usedRow = usedCursor.next().value
    const used = usedRow && usedRow.total ? Number(usedRow.total) : 0
    this.setSpaceUsed(used)
  }
}
