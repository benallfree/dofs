# Durable Objects File System (dofs)

A filesystem-like API for Cloudflare Durable Objects, supporting streaming reads and writes with chunked storage.

## Features

- File and directory operations (read, write, mkdir, rmdir, stat, etc.)
- Efficient chunked storage for large files
- Streaming read and write support via ReadableStream and WritableStream
- Designed for use in Durable Objects (DOs)

## Usage Example

### 1. Creating a dofs instance in your Durable Object

```ts
import { DurableObject } from 'cloudflare:workers'
import { Fs } from 'dofs'

export class MyDurableObject extends DurableObject<Env> {
  private fs: Fs

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.fs = new Fs(ctx, env)
  }

  // Expose fs methods as needed
  public async writeFile(path: string, data: string | ArrayBuffer | ReadableStream<Uint8Array>) {
    return this.fs.writeFile(path, data)
  }

  public readFile(path: string) {
    return this.fs.readFile(path)
  }

  // ...other methods
}
```

### 1a. Customizing chunk size

By default, the chunk size is 64kb. You can configure it by passing the `chunkSize` option (in bytes) to the `Fs` constructor:

```ts
import { Fs } from 'dofs'

const fs = new Fs(ctx, env, { chunkSize: 256 * 1024 }) // 256kb chunks
```

**How chunk size affects query frequency and cost:**

- Smaller chunk sizes mean more database queries per file read/write, which can increase Durable Object query costs and latency.
- Larger chunk sizes reduce the number of queries (lower cost, better throughput), but may use more memory per operation and can be less efficient for small files or random access.
- Choose a chunk size that balances your workload's cost, performance, and memory needs.

> **Note:** Chunk size cannot be changed after the first file has been written to the filesystem. It is fixed for the lifetime of the filesystem instance.

### 2. Exposing methods publicly

You can expose methods on your Durable Object class that call into the `fs` instance. For example, to support streaming uploads and downloads:

```ts
// In your DO class
public async writeFile(path: string, stream: ReadableStream<Uint8Array>) {
  return this.fs.writeFile(path, stream)
}

public readFile(path: string) {
  return this.fs.readFile(path)
}
```

On the consumer side, you can call these methods via your RPC/stub mechanism, passing a stream for uploads and receiving a stream for downloads.

### 3. Streaming support

- **Read:** `readFile(path)` returns a `ReadableStream<Uint8Array>` for efficient, chunked reading.
- **Write:** `writeFile(path, stream)` accepts a `ReadableStream<Uint8Array>` for efficient, chunked writing.
- You can also use `writeFile(path, data)` with a string or ArrayBuffer for non-streaming writes.

### 4. Chunk size configuration

- The chunk size is currently fixed at 1MB (`1024 * 1024` bytes) for both reads and writes.
- **Note:** The chunk size is fixed for each file at creation time and cannot be changed later. A future `defrag()` method will allow changing chunk size and re-chunking files.

## Future Plans

- In-memory block caching for improved read/write performance
- Store small files (that fit in one block) directly in the inode table instead of the chunk table to reduce queries
- `defrag()` method to allow changing chunk size and optimizing storage

## API

- `fs.readFile(path: string): ReadableStream<Uint8Array>`
- `fs.writeFile(path: string, data: string | ArrayBuffer | ReadableStream<Uint8Array>): Promise<void>`
- `fs.read(path: string, options): ArrayBuffer` (non-streaming, offset/length)
- `fs.write(path: string, data, options): void` (non-streaming, offset)
- `fs.mkdir(path: string, options?): void`
- `fs.rmdir(path: string, options?): void`
- `fs.listDir(path: string, options?): string[]`
- `fs.stat(path: string): Stat`
- `fs.unlink(path: string): void`
- `fs.rename(oldPath: string, newPath: string): void`
- `fs.symlink(target: string, path: string): void`
- `fs.readlink(path: string): string`

See the source for more details and options.
