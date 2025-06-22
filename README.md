# Durable Objects File System (dofs)

A filesystem-like API for Cloudflare Durable Objects, supporting streaming reads and writes with chunked storage.

## Features

- File and directory operations (read, write, mkdir, rmdir, stat, etc.)
- Efficient chunked storage for large files
- Streaming read and write support via ReadableStream and WritableStream
- Designed for use in Durable Objects (DOs)

## Basic Usage

The recommended way to add dofs to your Durable Object is using the `@Dofs` decorator:

```ts
import { DurableObject } from 'cloudflare:workers'
import { Dofs } from 'dofs'

@Dofs({ chunkSize: 256 * 1024 })
export class MyDurableObject extends DurableObject<Env> {
  // Your custom methods here
  // Access filesystem via this.getFs()
}
```

The `@Dofs` decorator:

- Automatically creates the `fs` property in your Durable Object
- Adds a `getFs()` method to access the filesystem instance
- Accepts the same configuration options as the `Fs` constructor
- Works directly with classes extending `DurableObject`

### Alternative: Using withDofs Helper

For cases where you need more control or are working with existing class hierarchies, you can use the `withDofs` helper:

```ts
import { DurableObject } from 'cloudflare:workers'
import { withDofs } from 'dofs'

// Create a concrete base class first
class MyDurableObjectBase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
}

// Then extend it with dofs
export class MyDurableObject extends withDofs(MyDurableObjectBase) {
  // Your custom methods here
}

// Or with configuration options:
export class MyDurableObject extends withDofs(MyDurableObjectBase, { chunkSize: 256 * 1024 }) {
  // Your custom methods here
}
```

**Important:** Due to TypeScript declaration generation limitations, `withDofs` requires a concrete base class. You cannot pass the abstract `DurableObject` class directly to `withDofs`.

Both approaches provide the same functionality:

- Automatically creates the `fs` property in your Durable Object
- Adds a `getFs()` method to access the filesystem instance
- Accepts the same configuration options as the `Fs` constructor

> Note: class instances can be [passed via RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/#class-instances) as long as they inherit from `RpcTarget` as `Fs` does.

### Advanced: Manual Setup

For more control, you can manually create a dofs instance in your Durable Object:

```ts
import { DurableObject } from 'cloudflare:workers'
import { Fs } from 'dofs'

export class MyDurableObject extends DurableObject<Env> {
  private fs: Fs

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.fs = new Fs(ctx, env)
  }

  // Expose fs
  public getDofs() {
    return this.fs
  }
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
- You can check the current device size and usage with `getDeviceStats()`.

```ts
const stats = fs.getDeviceStats()
console.log(stats.deviceSize, stats.spaceUsed, stats.spaceAvailable)
```

> **Default:** 1GB if not set.

## Streaming Support

- **Read:** `readFile(path)` returns a `ReadableStream<Uint8Array>` for efficient, chunked reading.
- **Write:** `writeFile(path, stream)` accepts a `ReadableStream<Uint8Array>` for efficient, chunked writing.
- You can also use `writeFile(path, data)` with a string or ArrayBuffer for non-streaming writes.

## API Reference

**Note:** These are async from the CF Worker stub (RPC call), but are sync when called inside the Durable Object (direct call).

- `readFile(path: string): ReadableStream<Uint8Array>`
- `writeFile(path: string, data: string | ArrayBuffer | ReadableStream<Uint8Array>): void`
- `read(path: string, options): ArrayBuffer` (non-streaming, offset/length)
- `write(path: string, data, options): void` (non-streaming, offset)
- `mkdir(path: string, options?): void`
- `rmdir(path: string, options?): void`
- `listDir(path: string, options?): string[]`
- `stat(path: string): Stat`
- `unlink(path: string): void`
- `rename(oldPath: string, newPath: string): void`
- `symlink(target: string, path: string): void`
- `readlink(path: string): string`

## Projects that work with dofs

- dterm

## Future Plans

- In-memory block caching for improved read/write performance
- Store small files (that fit in one block) directly in the inode table instead of the chunk table to reduce queries
- `defrag()` method to allow changing chunk size and optimizing storage
