import { IDurableObjectFs } from 'dofs'
import { Hono } from 'hono'

export const dterm = (getDofsStub: (env: Env) => DurableObjectStub<IDurableObjectFs & Rpc.DurableObjectBranded>) => {
  const api = new Hono<{ Bindings: Env }>()

  api.post('/upload', async (c) => {
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

  api.get('/ls', async (c) => {
    const stub = getDofsStub(c.env)
    const path = c.req.query('path') || '/'
    const entries = await stub.listDir(path)
    const stats = await Promise.all(
      entries
        .filter((e: string) => e !== '.' && e !== '..')
        .map(async (e: string) => {
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

  api.get('/file', async (c) => {
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
      // @ts-expect-error
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

  api.post('/rm', async (c) => {
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

  api.post('/mkdir', async (c) => {
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

  api.post('/rmdir', async (c) => {
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

  api.post('/mv', async (c) => {
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

  api.post('/symlink', async (c) => {
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

  api.get('/stat', async (c) => {
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

  api.get('/df', async (c) => {
    const stub = getDofsStub(c.env)
    const stats = await stub.getDeviceStats()
    return c.json(stats)
  })

  return api
}
