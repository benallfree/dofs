import { DurableObject } from 'cloudflare:workers'
import {
  CreateOptions,
  Fs,
  IDurableObjectFs,
  ListDirOptions,
  MkdirOptions,
  ReadFileOptions,
  ReadOptions,
  RmdirOptions,
  SetAttrOptions,
  WriteFileOptions,
  WriteOptions,
} from 'dofs'
import { Hono } from 'hono'
import { dterm } from './dterm'

export class MyDurableObject extends DurableObject<Env> implements IDurableObjectFs {
  private fs: Fs

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.fs = new Fs(ctx, env, { chunkSize: 4 * 1024 })
  }

  public getFs() {
    return this.fs
  }

  // Expose all fs methods as sync public methods
  public readFile(path: string, options?: ReadFileOptions) {
    return this.fs.readFile(path, options)
  }
  public writeFile(path: string, data: ArrayBuffer | string | ReadableStream<Uint8Array>, options?: WriteFileOptions) {
    return this.fs.writeFile(path, data, options)
  }
  public read(path: string, options: ReadOptions) {
    return this.fs.read(path, options)
  }
  public write(path: string, data: ArrayBuffer | string, options: WriteOptions) {
    return this.fs.write(path, data, options)
  }
  public mkdir(path: string, options?: MkdirOptions) {
    return this.fs.mkdir(path, options)
  }
  public rmdir(path: string, options?: RmdirOptions) {
    return this.fs.rmdir(path, options)
  }
  public listDir(path: string, options?: ListDirOptions) {
    return this.fs.listDir(path, options)
  }
  public stat(path: string) {
    return this.fs.stat(path)
  }
  public setattr(path: string, options: SetAttrOptions) {
    return this.fs.setattr(path, options)
  }
  public symlink(target: string, path: string) {
    return this.fs.symlink(target, path)
  }
  public readlink(path: string) {
    return this.fs.readlink(path)
  }
  public rename(oldPath: string, newPath: string) {
    return this.fs.rename(oldPath, newPath)
  }
  public unlink(path: string) {
    return this.fs.unlink(path)
  }
  public getDeviceStats() {
    return this.fs.getDeviceStats()
  }
  public create(path: string, options?: CreateOptions) {
    return this.fs.create(path, options)
  }
  public truncate(path: string, size: number) {
    return this.fs.truncate(path, size)
  }
  public setDeviceSize(newSize: number) {
    return this.fs.setDeviceSize(newSize)
  }
}

const app = new Hono<{ Bindings: Env }>()

// Mount the API middleware
app.route(
  '/',
  dterm((env: Env) => {
    const id = env.MY_DURABLE_OBJECT.idFromName('dofs')
    return env.MY_DURABLE_OBJECT.get(id)
  })
)

export default app
