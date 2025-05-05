import {
  DurableObjectFs,
  ListDirOptions,
  MkdirOptions,
  ReadFileOptions,
  ReadOptions,
  RmdirOptions,
  SetAttrOptions,
  Stat,
  WriteFileOptions,
  WriteOptions,
} from 'dofs'
import { Hono } from 'hono'

export class MyDurableObject extends DurableObjectFs<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  // Expose all fs methods as sync public methods
  public readFile(path: string, options?: ReadFileOptions): ArrayBuffer | string {
    return this.ctx.storage.fs.readFile(path, options)
  }
  public writeFile(path: string, data: ArrayBuffer | string, options?: WriteFileOptions): void {
    return this.ctx.storage.fs.writeFile(path, data, options)
  }
  public read(path: string, options: ReadOptions): ArrayBuffer | string {
    return this.ctx.storage.fs.read(path, options)
  }
  public write(path: string, data: ArrayBuffer | string, options: WriteOptions): void {
    return this.ctx.storage.fs.write(path, data, options)
  }
  public mkdir(path: string, options?: MkdirOptions): void {
    return this.ctx.storage.fs.mkdir(path, options)
  }
  public rmdir(path: string, options?: RmdirOptions): void {
    return this.ctx.storage.fs.rmdir(path, options)
  }
  public listDir(path: string, options?: ListDirOptions): string[] {
    return this.ctx.storage.fs.listDir(path, options)
  }
  public stat(path: string): Stat {
    return this.ctx.storage.fs.stat(path)
  }
  public setattr(path: string, options: SetAttrOptions): void {
    return this.ctx.storage.fs.setattr(path, options)
  }
  public symlink(target: string, path: string): void {
    return this.ctx.storage.fs.symlink(target, path)
  }
  public readlink(path: string): string {
    return this.ctx.storage.fs.readlink(path)
  }
  public rename(oldPath: string, newPath: string): void {
    return this.ctx.storage.fs.rename(oldPath, newPath)
  }
  public unlink(path: string): void {
    return this.ctx.storage.fs.unlink(path)
  }
}

const app = new Hono<{ Bindings: Env }>()

app.post('/upload', async (c) => {
  const env = c.env
  let id = env.MY_DURABLE_OBJECT.idFromName(`dofs`)
  let stub = env.MY_DURABLE_OBJECT.get(id)
  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return c.text('No file uploaded', 400)
  }
  const arrayBuffer = await file.arrayBuffer()
  console.log(`uploaded ${file.name}`)
  await stub.writeFile('/' + file.name, arrayBuffer)
  return c.redirect('/')
})

app.get('/api/ls', async (c) => {
  const env = c.env
  const path = c.req.query('path') || '/'
  let id = env.MY_DURABLE_OBJECT.idFromName('dofs')
  let stub = env.MY_DURABLE_OBJECT.get(id)
  const entries = await stub.listDir(path)
  const stats = await Promise.all(
    entries
      .filter((e) => e !== '.' && e !== '..')
      .map(async (e) => {
        try {
          const s = await stub.stat((path.endsWith('/') ? path : path + '/') + e)
          return { name: e, ...s }
        } catch (err) {
          return { name: e, error: true }
        }
      })
  )
  return c.json(stats)
})

export default app
