import { DurableObject } from 'cloudflare:workers'
import {
  DurableObjectFs,
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

export class MyDurableObject extends DurableObject<Env> {
  private fs: DurableObjectFs

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.fs = new DurableObjectFs(ctx, env)
  }

  // Expose all fs methods as sync public methods
  public readFile(path: string, options?: ReadFileOptions) {
    return this.fs.readFile(path, options)
  }
  public writeFile(path: string, stream: any, options?: WriteFileOptions) {
    return this.fs.writeFile(path, stream, options)
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
  const dir = c.req.query('path') || '/'
  const finalPath = (dir.endsWith('/') ? dir : dir + '/') + file.name
  await stub.writeFile(finalPath, file.stream())
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
    const stat = await stub.stat(path)
    const size = stat.size
    const stream = await stub.readFile(path)
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-disposition': `inline; filename="${encodeURIComponent(path.split('/').pop() || 'file')}"`,
        'content-length': String(size),
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
