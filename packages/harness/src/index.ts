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

app.get('/', async (c) => {
  const env = c.env
  let id = env.MY_DURABLE_OBJECT.idFromName(`dofs`)
  let stub = env.MY_DURABLE_OBJECT.get(id)
  const entries = await stub.listDir('/')
  // Get stats for each entry
  const stats = await Promise.all(
    entries.map(async (e) => {
      try {
        const s = await stub.stat('/' + e)
        return { name: e, ...s }
      } catch (err) {
        return { name: e, error: true }
      }
    })
  )
  function isStat(f: any): f is Stat & { name: string } {
    return !f.error
  }
  function pad(str: string, len: number, right = false) {
    str = String(str)
    if (str.length >= len) return str.slice(0, len)
    return right ? str.padEnd(len, ' ') : str.padStart(len, ' ')
  }
  const header = `${pad('MODE', 6, true)} ${pad('UID', 4)} ${pad('GID', 4)} ${pad('SIZE', 8)} ${pad('MTIME', 20, true)} NAME`
  const lines = stats.map((f) => {
    if (!isStat(f)) return pad('', 6, true) + ' '.repeat(4 + 4 + 8 + 20 + 1) + f.name + ' (error)'
    const mode = f.mode ? f.mode.toString(8) : ''
    const mtime = f.mtime ? new Date(f.mtime).toLocaleString() : ''
    return `${pad(String(mode), 6, true)} ${pad(String(f.uid ?? ''), 4)} ${pad(String(f.gid ?? ''), 4)} ${pad(String(f.size ?? ''), 8)} ${pad(String(mtime), 20, true)} ${f.name}${f.isDirectory ? '/' : ''}`
  })
  const html = `<!DOCTYPE html><html><head><title>Root Directory</title></head><body><h1>Root Directory</h1><form id="upload-form" action="/upload" method="post" enctype="multipart/form-data" style="margin-bottom:1em; padding:1em; text-align:center;"><input id="file-input" type="file" name="file" required><button type="submit">Upload</button></form><pre style="font-family:monospace; background:#222; color:#eee; padding:1em; border-radius:6px;">${header}\n${lines.join('\n')}</pre></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html' } })
})

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

export default app
