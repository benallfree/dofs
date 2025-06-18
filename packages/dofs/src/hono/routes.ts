import { Hono } from 'hono'
import { DofsContext } from './types.js'

export const createFsRoutes = <TEnv extends Cloudflare.Env>() => {
  const fsRoutes = new Hono<{ Bindings: TEnv } & DofsContext>()

  fsRoutes.post('/upload', async (c) => {
    const fs = c.get('fs')
    const formData = await c.req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return c.text('No file uploaded', 400)
    }
    const dir = c.req.query('path') || '/'
    const finalPath = (dir.endsWith('/') ? dir : dir + '/') + file.name
    await fs.writeFile(finalPath, file.stream())
    return c.redirect('/')
  })

  fsRoutes.get('/ls', async (c) => {
    const fs = c.get('fs')
    const path = c.req.query('path') || '/'
    const entries = await fs.listDir(path)
    const stats = await Promise.all(
      entries
        .filter((e: string) => e !== '.' && e !== '..')
        .map(async (e: string) => {
          try {
            const s = await fs.stat((path.endsWith('/') ? path : path + '/') + e)
            return { name: e, ...s }
          } catch (err) {
            return { name: e, error: true }
          }
        })
    )
    return c.json(stats)
  })

  fsRoutes.get('/file', async (c) => {
    const fs = c.get('fs')
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
      const stat = await fs.stat(path)
      const size = stat.size
      const stream = await fs.readFile(path)
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

  fsRoutes.post('/rm', async (c) => {
    const fs = c.get('fs')
    const path = c.req.query('path')
    if (!path) return c.text('Missing path', 400)
    try {
      await fs.unlink(path)
      return c.text('OK')
    } catch (e) {
      return c.text('Not found', 404)
    }
  })

  fsRoutes.post('/mkdir', async (c) => {
    const fs = c.get('fs')
    const path = c.req.query('path')
    if (!path) return c.text('Missing path', 400)
    try {
      await fs.mkdir(path)
      return c.text('OK')
    } catch (e) {
      return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
    }
  })

  fsRoutes.post('/rmdir', async (c) => {
    const fs = c.get('fs')
    const path = c.req.query('path')
    if (!path) return c.text('Missing path', 400)
    try {
      await fs.rmdir(path)
      return c.text('OK')
    } catch (e) {
      return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
    }
  })

  fsRoutes.post('/mv', async (c) => {
    const fs = c.get('fs')
    const src = c.req.query('src')
    const dest = c.req.query('dest')
    if (!src || !dest) return c.text('Missing src or dest', 400)
    try {
      await fs.rename(src, dest)
      return c.text('OK')
    } catch (e) {
      return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
    }
  })

  fsRoutes.post('/symlink', async (c) => {
    const fs = c.get('fs')
    const target = c.req.query('target')
    const path = c.req.query('path')
    if (!target || !path) return c.text('Missing target or path', 400)
    try {
      await fs.symlink(target, path)
      return c.text('OK')
    } catch (e) {
      return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
    }
  })

  fsRoutes.get('/stat', async (c) => {
    const fs = c.get('fs')
    const path = c.req.query('path')
    if (!path) return c.text('Missing path', 400)
    try {
      const stat = await fs.stat(path)
      return c.json(stat)
    } catch (e) {
      return c.text('Error: ' + (e instanceof Error ? e.message : String(e)), 400)
    }
  })

  fsRoutes.get('/df', async (c) => {
    const fs = c.get('fs')
    const stats = await fs.getDeviceStats()
    return c.json(stats)
  })

  return fsRoutes
}
