import { Hono } from 'hono'
import { WithDofs } from '../withDofs.js'
import { createFsRoutes } from './routes.js'
import { DofsContext, DurableObjectConfig } from './types.js'
import { createWebSocketHandler } from './websocket.js'

export * from './types.js'

export const dofs = <TEnv extends Cloudflare.Env>(config: DurableObjectConfig) => {
  const api = new Hono<{ Bindings: TEnv } & DofsContext>()

  const getFs = async (doNamespace: string, doName: string, env: Cloudflare.Env) => {
    if (!(doNamespace in env)) {
      throw new Error(`Durable Object namespace ${doNamespace} not found`)
    }
    const ns = env[doNamespace as keyof Cloudflare.Env] as DurableObjectNamespace<WithDofs<TEnv>>
    const doId = ns.idFromName(doName)
    const stub: DurableObjectStub<WithDofs<TEnv>> = ns.get(doId)
    return stub.getFs()
  }

  // Create filesystem routes
  const fsRoutes = createFsRoutes<TEnv>()

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
  api.get('/ws', createWebSocketHandler(config, getFs))

  return api
}
