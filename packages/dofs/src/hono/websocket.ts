import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { getInstanceStat, getNamespaceStat, getRootStat } from './stats.js'
import { DurableObjectConfig } from './types.js'

export const createWebSocketHandler = <TEnv extends Cloudflare.Env>(
  config: DurableObjectConfig,
  getFs: (doNamespace: string, doName: string, env: Cloudflare.Env) => Promise<any>
) => {
  return upgradeWebSocket((c) => {
    const env = c.env // Capture the environment for durable object access
    const { dos } = config

    return {
      async onMessage(event, ws) {
        console.log('WebSocket message received:', event.data)

        try {
          const message = JSON.parse(event.data.toString())

          // Handle FUSE readdir operation for root directory
          if (message.operation === 'readdir' && message.path === '/') {
            // Get list of durable object namespaces from config
            const namespaces: string[] = []

            for (const [namespace, doConfig] of Object.entries(dos)) {
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

            if (namespaceName in dos) {
              try {
                // Get instances for this namespace
                const instances = await dos[namespaceName].getInstances()
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
              // Root directory stat - use a stable timestamp
              const stat = await getRootStat(config)
              const response = {
                id: message.id,
                success: true,
                operation: 'getattr',
                data: stat,
              }
              ws.send(JSON.stringify(response))
              return
            } else if (requestedPath.startsWith('/') && !requestedPath.includes('/', 1)) {
              // Top-level namespace directory
              const namespaceName = requestedPath.substring(1)

              if (namespaceName in dos) {
                try {
                  // Get timestamps from the namespace configuration
                  const stat = await getNamespaceStat(config, namespaceName)

                  // Valid namespace - return directory stat
                  const response = {
                    id: message.id,
                    success: true,
                    operation: 'getattr',
                    data: stat,
                  }
                  ws.send(JSON.stringify(response))
                  return
                } catch (error) {
                  // Error getting timestamps
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
            } else if (requestedPath.startsWith('/')) {
              // Check if this is a valid instance path: /NAMESPACE/INSTANCE-SLUG
              const pathParts = requestedPath.split('/').filter((part: string) => part.length > 0)

              if (pathParts.length === 2) {
                const [namespaceName, instanceSlug] = pathParts

                if (namespaceName in dos) {
                  try {
                    // Get instances for this namespace and check if this slug exists
                    const instances = await dos[namespaceName].getInstances()
                    const instanceExists = instances.some((instance) => instance.slug === instanceSlug)

                    if (instanceExists) {
                      // Get timestamps from the instance configuration
                      const stat = await getInstanceStat(config, namespaceName, instanceSlug)

                      // Valid instance - return directory stat
                      const response = {
                        id: message.id,
                        success: true,
                        operation: 'getattr',
                        data: stat,
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
                    // Error getting instances or timestamps
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

          // Handle FUSE write operation
          if (message.operation === 'write') {
            const { namespace, instanceSlug, path, content, encoding } = message

            if (!namespace || !instanceSlug || !path || !content) {
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'Missing required parameters',
              }
              ws.send(JSON.stringify(response))
              return
            }

            if (!(namespace in dos)) {
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'ENOENT',
              }
              ws.send(JSON.stringify(response))
              return
            }

            try {
              // Validate that the instance exists
              const instances = await dos[namespace].getInstances()
              const instanceExists = instances.some((instance) => instance.slug === instanceSlug)

              if (!instanceExists) {
                const response = {
                  id: message.id,
                  success: false,
                  operation: 'write',
                  error: 'ENOENT',
                }
                ws.send(JSON.stringify(response))
                return
              }

              // Decode the file content
              let fileData: Buffer
              if (encoding === 'base64') {
                fileData = Buffer.from(content, 'base64')
              } else {
                fileData = Buffer.from(content, 'utf8')
              }

              // Get the filesystem for this durable object instance and write the file
              const fs = await getFs(namespace, instanceSlug, env)
              await fs.writeFile(path, fileData)

              console.log(`✅ Wrote ${fileData.length} bytes to ${namespace}/${instanceSlug}${path}`)

              const response = {
                id: message.id,
                success: true,
                operation: 'write',
                bytesWritten: fileData.length,
              }
              ws.send(JSON.stringify(response))
              return
            } catch (error) {
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'EIO',
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
}
