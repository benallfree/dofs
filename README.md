# Durable Objects File System (dofs)

A filesystem-like API for Cloudflare Durable Objects, supporting streaming reads and writes with chunked storage.

## Features

- File and directory operations (read, write, mkdir, rmdir, stat, etc.)
- Efficient chunked storage for large files
- Streaming read and write support via ReadableStream and WritableStream
- Designed for use in Durable Objects (DOs)

## Basic Usage

Create a dofs instance in your Durable Object:

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

## Configuration Options

### Chunk Size

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

### Device Size

By default, the device size (total storage available) is 1GB (`1024 * 1024 * 1024` bytes). You can change this limit using the `setDeviceSize` method:

```ts
fs.setDeviceSize(10 * 1024 * 1024 * 1024) // Set device size to 10GB
```

- The device size must be set before writing data that would exceed the current limit.
- If you try to write more data than the device size allows, an `ENOSPC` error will be thrown.
- You can check the current device size and usage with `fs.getDeviceStats()`.

```ts
const stats = fs.getDeviceStats()
console.log(stats.deviceSize, stats.spaceUsed, stats.spaceAvailable)
```

> **Default:** 1GB if not set.

## Streaming Support

- **Read:** `readFile(path)` returns a `ReadableStream<Uint8Array>` for efficient, chunked reading.
- **Write:** `writeFile(path, stream)` accepts a `ReadableStream<Uint8Array>` for efficient, chunked writing.
- You can also use `writeFile(path, data)` with a string or ArrayBuffer for non-streaming writes.

## Public Interface

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

### IDurableObjectFs Interface

If you want your Durable Object to publicly expose the filesystem methods, you can use the `IDurableObjectFs` interface for type safety and documentation. This interface defines the full set of methods available on the filesystem:

```ts
import type { IDurableObjectFs } from 'dofs'

export class MyDurableObject implements IDurableObjectFs {
  // ... implement or delegate to an Fs instance
}
```

This is useful for:

- Ensuring your Durable Object exposes the same API as the filesystem
- Type checking and editor autocompletion
- Documenting which methods are available for RPC or public access

You can implement the interface directly, or delegate each method to an internal `Fs` instance.

> **Tip:** Use this interface if you want to make your Durable Object a drop-in replacement for the filesystem API, or to clearly document which methods are available for remote calls.

## API Reference

**Note:** These are async from the CF Worker stub (RPC call), but are sync when called inside the Durable Object (direct call).

- `fs.readFile(path: string): ReadableStream<Uint8Array>`
- `fs.writeFile(path: string, data: string | ArrayBuffer | ReadableStream<Uint8Array>): void`
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

## Projects that work with dofs

- dterm
- dofsgui

## Future Plans

- In-memory block caching for improved read/write performance
- Store small files (that fit in one block) directly in the inode table instead of the chunk table to reduce queries
- `defrag()` method to allow changing chunk size and optimizing storage
