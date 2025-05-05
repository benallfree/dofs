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
  public getDeviceStats(): { deviceSize: number; spaceUsed: number; spaceAvailable: number } {
    return this.ctx.storage.fs.getDeviceStats()
  }
}

const app = new Hono<{ Bindings: Env }>()

function getDofsStub(env: Env) {
  const id = env.MY_DURABLE_OBJECT.idFromName('dofs')
  return env.MY_DURABLE_OBJECT.get(id)
}

app.post('/api/upload', async (c) => {
  const stub = getDofsStub(c.env)
  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return c.text('No file uploaded', 400)
  }
  const arrayBuffer = await file.arrayBuffer()
  const dir = c.req.query('path') || '/'
  const finalPath = (dir.endsWith('/') ? dir : dir + '/') + file.name
  const tempPath = finalPath + '.uploading'
  const CHUNK_SIZE = 1024 * 1024 // 1MB
  const buf = new Uint8Array(arrayBuffer)
  console.log('writing', { length: buf.length })
  let offset = 0
  while (offset < buf.length) {
    const end = Math.min(offset + CHUNK_SIZE, buf.length)
    const chunk = buf.slice(offset, end)
    console.log('writing chunk', { offset, length: chunk.length })
    await stub.write(tempPath, chunk, { offset })
    offset = end
  }
  await stub.rename(tempPath, finalPath)
  return c.redirect('/')
})

app.get('/api/ls', async (c) => {
  const stub = getDofsStub(c.env)
  const path = c.req.query('path') || '/'
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

app.get('/api/file', async (c) => {
  const stub = getDofsStub(c.env)
  const path = c.req.query('path')
  if (!path) return c.text('Missing path', 400)
  try {
    const data = await stub.readFile(path)
    // Try to guess content type from extension
    const ext = (path.split('.').pop() || '').toLowerCase()
    const typeMap = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    }
    const contentType = typeMap[ext as keyof typeof typeMap] || 'application/octet-stream'
    // Add Content-Disposition header to suggest filename and inline display
    return new Response(data, {
      headers: {
        'content-type': contentType,
        'content-disposition': `inline; filename="${encodeURIComponent(path.split('/').pop() || 'file')}"`,
      },
    })
  } catch (e) {
    return c.text('Not found', 404)
  }
})

app.post('/api/rm', async (c) => {
  const stub = getDofsStub(c.env)
  const path = c.req.query('path')
  if (!path) return c.text('Missing path', 400)
  try {
    await stub.unlink(path)
    return c.text('OK')
  } catch (e) {
    return c.text('Not found', 404)
  }
})

app.post('/api/mkdir', async (c) => {
  const stub = getDofsStub(c.env)
  const path = c.req.query('path')
  if (!path) return c.text('Missing path', 400)
  try {
    await stub.mkdir(path)
    return c.text('OK')
  } catch (e) {
    return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
  }
})

app.post('/api/rmdir', async (c) => {
  const stub = getDofsStub(c.env)
  const path = c.req.query('path')
  if (!path) return c.text('Missing path', 400)
  try {
    await stub.rmdir(path)
    return c.text('OK')
  } catch (e) {
    return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
  }
})

app.post('/api/mv', async (c) => {
  const stub = getDofsStub(c.env)
  const src = c.req.query('src')
  const dest = c.req.query('dest')
  if (!src || !dest) return c.text('Missing src or dest', 400)
  try {
    await stub.rename(src, dest)
    return c.text('OK')
  } catch (e) {
    return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
  }
})

app.post('/api/symlink', async (c) => {
  const stub = getDofsStub(c.env)
  const target = c.req.query('target')
  const path = c.req.query('path')
  if (!target || !path) return c.text('Missing target or path', 400)
  try {
    await stub.symlink(target, path)
    return c.text('OK')
  } catch (e) {
    return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
  }
})

app.get('/api/stat', async (c) => {
  const stub = getDofsStub(c.env)
  const path = c.req.query('path')
  if (!path) return c.text('Missing path', 400)
  try {
    const stat = await stub.stat(path)
    return c.json(stat)
  } catch (e) {
    return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
  }
})

app.get('/api/df', async (c) => {
  const stub = getDofsStub(c.env)
  const stats = await stub.getDeviceStats()
  return c.json(stats)
})

app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
