import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/cloudflare-workers'

// Extend the context type to include our fs property
type DofsContext = {
  Variables: {
    fs: any // The filesystem stub
  }
}

/**
 * Represents an instance of a Durable Object
 */
export interface DurableObjectInstance {
  /** The unique slug identifier for the instance */
  slug: string
  /** The display name of the instance */
  name: string
}

/**
 * Configuration for a single Durable Object
 */
export interface DurableObjectConfigItem {
  /** The name of the Durable Object */
  name: string
  /** Reference to the Durable Object class for compatibility checking */
  classRef: typeof DurableObject<any>
  /** Function to get instances, optionally paginated */
  getInstances: (page?: number) => Promise<DurableObjectInstance[]>
  /** List of compatible plugin slugs (populated at runtime) */
  compatiblePlugins?: string[]
}

/**
 * Configuration object for Durable Objects
 */
export type DurableObjectConfig = Record<string, DurableObjectConfigItem>

export const dofs = (config: DurableObjectConfig) => {
  const api = new Hono<{ Bindings: Cloudflare.Env } & DofsContext>()

  const getFs = async (doNamespace: string, doName: string, env: Cloudflare.Env) => {
    if (!(doNamespace in env)) {
      throw new Error(`Durable Object namespace ${doNamespace} not found`)
    }
    const ns = env[doNamespace as keyof Cloudflare.Env] as DurableObjectNamespace<any>
    const doId = ns.idFromName(doName)
    const stub: DurableObjectStub<any> = ns.get(doId)
    // @ts-ignore
    return stub.getFs()
  }

  // Create a sub-app for filesystem routes
  const fsRoutes = new Hono<{ Bindings: Cloudflare.Env } & DofsContext>()

  // All filesystem endpoints - no longer need /:doNamespace/:doId prefix
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

  // Middleware to extract filesystem stub and mount the fs routes
  api.use('/:doNamespace/:doId/*', async (c, next) => {
    const { doNamespace, doId } = c.req.param()
    try {
      const fs = await getFs(doNamespace, doId, c.env)
      c.set('fs', fs)
      await next()
    } catch (error) {
      return c.text(`Error accessing filesystem: ${error instanceof Error ? error.message : String(error)}`, 500)
    }
  })

  // Mount the filesystem routes at /:doNamespace/:doId
  api.route('/:doNamespace/:doId', fsRoutes)

  // WebSocket endpoint for FUSE operations
  api.get(
    '/ws',
    upgradeWebSocket((c) => {
      return {
        async onMessage(event, ws) {
          console.log('WebSocket message received:', event.data)

          try {
            const message = JSON.parse(event.data.toString())

            // Handle FUSE readdir operation for root directory
            if (message.operation === 'readdir' && message.path === '/') {
              // Get list of durable object namespaces from config
              const namespaces: string[] = []

              for (const [namespace, doConfig] of Object.entries(config)) {
                // Add namespace name as top-level directory
                // Each namespace will contain instances from doConfig.getInstances()
                namespaces.push(namespace)
              }

              const response = {
                id: message.id,
                success: true,
                operation: 'readdir',
                data: namespaces,
              }

              ws.send(JSON.stringify(response))
              return
            }

            // Handle FUSE readdir operation for namespace directories
            if (message.operation === 'readdir' && message.path.startsWith('/') && !message.path.includes('/', 1)) {
              const namespaceName = message.path.substring(1)

              if (namespaceName in config) {
                try {
                  // Get instances for this namespace
                  const instances = await config[namespaceName].getInstances()
                  const instanceSlugs = instances.map((instance) => instance.slug)

                  const response = {
                    id: message.id,
                    success: true,
                    operation: 'readdir',
                    data: instanceSlugs,
                  }

                  ws.send(JSON.stringify(response))
                  return
                } catch (error) {
                  // Error getting instances
                  const response = {
                    id: message.id,
                    success: false,
                    operation: 'readdir',
                    error: 'EIO',
                  }
                  ws.send(JSON.stringify(response))
                  return
                }
              } else {
                // Invalid namespace
                const response = {
                  id: message.id,
                  success: false,
                  operation: 'readdir',
                  error: 'ENOENT',
                }
                ws.send(JSON.stringify(response))
                return
              }
            }

            // Handle FUSE getattr operation for namespace validation
            if (message.operation === 'getattr') {
              const requestedPath = message.path

              if (requestedPath === '/') {
                // Root directory stat
                const response = {
                  id: message.id,
                  success: true,
                  operation: 'getattr',
                  data: {
                    mtime: new Date(),
                    atime: new Date(),
                    ctime: new Date(),
                    nlink: 1,
                    size: 4096,
                    mode: 16877, // Directory mode
                    uid: 0,
                    gid: 0,
                  },
                }
                ws.send(JSON.stringify(response))
                return
              } else if (requestedPath.startsWith('/') && !requestedPath.includes('/', 1)) {
                // Top-level namespace directory
                const namespaceName = requestedPath.substring(1)

                if (namespaceName in config) {
                  // Valid namespace - return directory stat
                  const response = {
                    id: message.id,
                    success: true,
                    operation: 'getattr',
                    data: {
                      mtime: new Date(),
                      atime: new Date(),
                      ctime: new Date(),
                      nlink: 1,
                      size: 4096,
                      mode: 16877, // Directory mode
                      uid: 0,
                      gid: 0,
                    },
                  }
                  ws.send(JSON.stringify(response))
                  return
                } else {
                  // Invalid namespace
                  const response = {
                    id: message.id,
                    success: false,
                    operation: 'getattr',
                    error: 'ENOENT',
                  }
                  ws.send(JSON.stringify(response))
                  return
                }
              } else if (requestedPath.startsWith('/')) {
                // Check if this is a valid instance path: /NAMESPACE/INSTANCE-SLUG
                const pathParts = requestedPath.split('/').filter((part) => part.length > 0)

                if (pathParts.length === 2) {
                  const [namespaceName, instanceSlug] = pathParts

                  if (namespaceName in config) {
                    try {
                      // Get instances for this namespace and check if this slug exists
                      const instances = await config[namespaceName].getInstances()
                      const instanceExists = instances.some((instance) => instance.slug === instanceSlug)

                      if (instanceExists) {
                        // Valid instance - return directory stat
                        const response = {
                          id: message.id,
                          success: true,
                          operation: 'getattr',
                          data: {
                            mtime: new Date(),
                            atime: new Date(),
                            ctime: new Date(),
                            nlink: 1,
                            size: 4096,
                            mode: 16877, // Directory mode
                            uid: 0,
                            gid: 0,
                          },
                        }
                        ws.send(JSON.stringify(response))
                        return
                      } else {
                        // Invalid instance
                        const response = {
                          id: message.id,
                          success: false,
                          operation: 'getattr',
                          error: 'ENOENT',
                        }
                        ws.send(JSON.stringify(response))
                        return
                      }
                    } catch (error) {
                      // Error getting instances
                      const response = {
                        id: message.id,
                        success: false,
                        operation: 'getattr',
                        error: 'EIO',
                      }
                      ws.send(JSON.stringify(response))
                      return
                    }
                  } else {
                    // Invalid namespace
                    const response = {
                      id: message.id,
                      success: false,
                      operation: 'getattr',
                      error: 'ENOENT',
                    }
                    ws.send(JSON.stringify(response))
                    return
                  }
                } else {
                  // Deeper paths not implemented yet
                  const response = {
                    id: message.id,
                    success: false,
                    operation: 'getattr',
                    error: 'ENOENT',
                  }
                  ws.send(JSON.stringify(response))
                  return
                }
              } else {
                // Deeper paths not implemented yet
                const response = {
                  id: message.id,
                  success: false,
                  operation: 'getattr',
                  error: 'ENOENT',
                }
                ws.send(JSON.stringify(response))
                return
              }
            }

            // Echo back other messages for now
            ws.send(
              JSON.stringify({
                id: message.id || 'unknown',
                success: true,
                echo: message,
              })
            )
          } catch (error) {
            // Send error response
            ws.send(
              JSON.stringify({
                success: false,
                error: 'Invalid JSON message',
              })
            )
          }
        },
        onOpen() {
          console.log('WebSocket connection opened')
        },
        onClose() {
          console.log('WebSocket connection closed')
        },
        onError(event) {
          console.error('WebSocket error:', event)
        },
      }
    })
  )

  return api
}
