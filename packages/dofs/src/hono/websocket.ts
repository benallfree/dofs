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

    // Track pending operations to clean up on disconnect
    const pendingOperations = new Set<string>()
    let isConnected = true

    // Helper function to safely send WebSocket messages
    const safeSend = (ws: any, data: string) => {
      if (isConnected) {
        try {
          ws.send(data)
        } catch (error) {
          console.warn('Failed to send WebSocket message:', error)
          isConnected = false
        }
      }
    }

    return {
      async onMessage(event, ws) {
        console.log('WebSocket message received:', event.data)

        try {
          const message = JSON.parse(event.data.toString())
          const operationId = message.id

          // Track this operation
          if (operationId) {
            pendingOperations.add(operationId)
          }

          // Helper to clean up and send response
          const sendResponse = (response: any) => {
            if (operationId) {
              pendingOperations.delete(operationId)
            }
            safeSend(ws, JSON.stringify(response))
          }

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

            sendResponse(response)
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

                sendResponse(response)
                return
              } catch (error) {
                // Error getting instances
                const response = {
                  id: message.id,
                  success: false,
                  operation: 'readdir',
                  error: 'EIO',
                }
                sendResponse(response)
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
              sendResponse(response)
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
              sendResponse(response)
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
                  sendResponse(response)
                  return
                } catch (error) {
                  // Error getting timestamps
                  const response = {
                    id: message.id,
                    success: false,
                    operation: 'getattr',
                    error: 'EIO',
                  }
                  sendResponse(response)
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
                sendResponse(response)
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
                      sendResponse(response)
                      return
                    } else {
                      // Invalid instance
                      const response = {
                        id: message.id,
                        success: false,
                        operation: 'getattr',
                        error: 'ENOENT',
                      }
                      sendResponse(response)
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
                    sendResponse(response)
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
                  sendResponse(response)
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
                sendResponse(response)
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
              sendResponse(response)
              return
            }
          }

          // Handle FUSE write operation
          if (message.operation === 'write') {
            const { path, content, encoding } = message

            if (!path || content == null || content === undefined) {
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'Missing required parameters',
              }
              sendResponse(response)
              return
            }

            // Parse the absolute path: /NAMESPACE/INSTANCE/file.txt
            const pathParts = path.split('/').filter((p: string) => p.length > 0)
            console.log(`🔍 Write request: path="${path}", parts=[${pathParts.join(', ')}]`)

            if (pathParts.length < 3) {
              console.warn(`🚫 Write denied: Invalid path structure "${path}" - must be /NAMESPACE/INSTANCE/filename`)
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'EACCES: Cannot write files to root or namespace directories',
              }
              sendResponse(response)
              return
            }

            const [namespace, instanceSlug, ...rest] = pathParts
            console.log(`🔍 Parsed: namespace="${namespace}", instance="${instanceSlug}", rest=[${rest.join(', ')}]`)

            // Step 1: Validate namespace exists in config
            console.log(`🔍 Step 1: Checking if namespace "${namespace}" exists in config...`)
            console.log(`🔍 Available namespaces: [${Object.keys(dos).join(', ')}]`)
            if (!(namespace in dos)) {
              console.warn(`🚫 Write denied: Unknown namespace "${namespace}"`)
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'ENOENT: Namespace not found',
              }
              sendResponse(response)
              return
            }
            console.log(`✅ Step 1: Namespace "${namespace}" found`)

            // Step 2: Validate instance ID exists in namespace
            console.log(`🔍 Step 2: Checking if instance "${instanceSlug}" exists in namespace "${namespace}"...`)
            try {
              const instances = await dos[namespace].getInstances()
              console.log(`🔍 Available instances: [${instances.map((i) => i.slug).join(', ')}]`)
              const instanceExists = instances.some((instance) => instance.slug === instanceSlug)

              if (!instanceExists) {
                console.warn(`🚫 Write denied: Unknown instance "${instanceSlug}" in namespace "${namespace}"`)
                const response = {
                  id: message.id,
                  success: false,
                  operation: 'write',
                  error: 'ENOENT: Instance not found',
                }
                sendResponse(response)
                return
              }
              console.log(`✅ Step 2: Instance "${instanceSlug}" found`)
            } catch (error) {
              console.warn(
                `🚫 Write denied: Error validating instance "${instanceSlug}" in namespace "${namespace}":`,
                error
              )
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'EIO: Error validating instance',
              }
              sendResponse(response)
              return
            }

            // Step 3 (write only): Validate rest.length > 0 (there's actually a file path)
            console.log(`🔍 Step 3: Checking if file path is specified (rest.length=${rest.length})...`)
            if (rest.length === 0) {
              console.warn(`🚫 Write denied: Cannot write to instance directory itself "${path}"`)
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'EACCES: Cannot write files to instance directory - must specify a filename',
              }
              sendResponse(response)
              return
            }
            console.log(`✅ Step 3: File path specified`)

            // Construct the internal path for the durable object filesystem
            const internalPath = '/' + rest.join('/')
            console.log(`🔍 Internal path: "${internalPath}"`)

            try {
              // Decode the file content using Web APIs (Buffer not available in Workers)
              console.log(`🔍 Decoding content (encoding=${encoding}, content.length=${content.length})...`)
              let fileData: Uint8Array
              if (encoding === 'base64') {
                // Use atob() for base64 decoding in Workers
                const binaryString = atob(content)
                fileData = new Uint8Array(binaryString.length)
                for (let i = 0; i < binaryString.length; i++) {
                  fileData[i] = binaryString.charCodeAt(i)
                }
              } else {
                // Use TextEncoder for UTF-8 encoding in Workers
                const encoder = new TextEncoder()
                fileData = encoder.encode(content)
              }
              console.log(`🔍 Decoded ${fileData.length} bytes`)

              // Get the filesystem for this durable object instance and write the file
              console.log(`🔍 Getting filesystem for ${namespace}/${instanceSlug}...`)
              const fs = await getFs(namespace, instanceSlug, env)
              console.log(`🔍 Got filesystem, writing to "${internalPath}"...`)

              await fs.writeFile(internalPath, fileData)

              console.log(`✅ Wrote ${fileData.length} bytes to ${namespace}/${instanceSlug}${internalPath}`)

              const response = {
                id: message.id,
                success: true,
                operation: 'write',
                bytesWritten: fileData.length,
              }
              sendResponse(response)
              return
            } catch (error) {
              console.warn(
                `🚫 Write denied: Filesystem error writing to ${namespace}/${instanceSlug}${internalPath}:`,
                error
              )
              const response = {
                id: message.id,
                success: false,
                operation: 'write',
                error: 'EIO: Filesystem write error',
              }
              sendResponse(response)
              return
            }
          }

          // Echo back other messages for now
          const response = {
            id: message.id || 'unknown',
            success: true,
            echo: message,
          }
          sendResponse(response)
        } catch (error) {
          // Send error response
          const response = {
            success: false,
            error: 'Invalid JSON message',
          }
          safeSend(ws, JSON.stringify(response))
        }
      },
      onOpen() {
        console.log('WebSocket connection opened')
        isConnected = true
      },
      onClose() {
        console.log('WebSocket connection closed')
        isConnected = false

        // Clean up any pending operations
        if (pendingOperations.size > 0) {
          console.log(`Cleaning up ${pendingOperations.size} pending operations on disconnect`)
          pendingOperations.clear()
        }
      },
      onError(event) {
        console.error('WebSocket error:', event)
        isConnected = false
      },
    }
  })
}
