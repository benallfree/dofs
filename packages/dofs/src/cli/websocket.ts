import * as WebSocket from 'ws'
import { MountOptions } from './types.js'

export interface WebSocketManager {
  sendRequest: (message: any, retryCount?: number) => Promise<any>
  isReady: () => boolean
  close: () => void
}

export function createWebSocketManager(wsEndpoint: string, options: MountOptions): Promise<WebSocketManager> {
  return new Promise<WebSocketManager>((resolve, reject) => {
    const ws = new WebSocket.WebSocket(wsEndpoint)
    let wsReady = false
    const pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()

    // Connection state management
    let isReconnecting = false
    let reconnectAttempts = 0
    const maxReconnectAttempts = 5

    // Queue for requests during reconnection
    const requestQueue: Array<{ message: any; resolve: (value: any) => void; reject: (error: Error) => void }> = []

    // WebSocket reconnection function
    const reconnectWebSocket = async (): Promise<void> => {
      if (isReconnecting) {
        throw new Error('Already reconnecting')
      }

      isReconnecting = true
      wsReady = false

      // Much shorter delay for filesystem responsiveness
      const delay = Math.min(200 * Math.pow(1.5, reconnectAttempts), 2000) // Max 2 seconds
      if (options.debug) {
        console.log(
          `🔄 Reconnecting to WebSocket in ${delay}ms (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})...`
        )
      }

      await new Promise((resolve) => setTimeout(resolve, delay))

      return new Promise<void>((resolve, reject) => {
        const newWs = new WebSocket.WebSocket(wsEndpoint)

        // Set a connection timeout
        const connectionTimeout = setTimeout(() => {
          newWs.close()
          isReconnecting = false
          reconnectAttempts++

          if (reconnectAttempts >= maxReconnectAttempts) {
            reject(new Error('WebSocket reconnection failed'))
          } else {
            // Quick retry for filesystem operations
            setTimeout(() => {
              reconnectWebSocket().then(resolve).catch(reject)
            }, 50)
          }
        }, 2000) // 2 second connection timeout

        newWs.on('open', () => {
          clearTimeout(connectionTimeout)
          if (options.debug) {
            console.log('✅ WebSocket reconnected successfully')
          }

          // Replace the old WebSocket with the new one
          ws.removeAllListeners()
          Object.setPrototypeOf(ws, Object.getPrototypeOf(newWs))
          Object.assign(ws, newWs)
          setupWebSocket(ws)

          wsReady = true
          isReconnecting = false
          reconnectAttempts = 0

          // Process queued requests
          while (requestQueue.length > 0) {
            const queuedRequest = requestQueue.shift()!
            sendWsRequest(queuedRequest.message).then(queuedRequest.resolve).catch(queuedRequest.reject)
          }

          resolve()
        })

        newWs.on('error', (error) => {
          clearTimeout(connectionTimeout)
          isReconnecting = false
          reconnectAttempts++

          if (reconnectAttempts >= maxReconnectAttempts) {
            reject(new Error('WebSocket reconnection failed'))
          } else {
            // Quick retry for filesystem operations
            setTimeout(() => {
              reconnectWebSocket().then(resolve).catch(reject)
            }, 50)
          }
        })
      })
    }

    // Helper function to send WebSocket requests
    const sendWsRequest = (message: any, retryCount = 0): Promise<any> => {
      return new Promise((resolve, reject) => {
        // If we're reconnecting, queue the request
        if (isReconnecting) {
          if (options.debug) {
            console.log('⏳ Queueing request during reconnection:', message.operation)
          }
          requestQueue.push({ message, resolve, reject })
          return
        }

        // Check WebSocket state immediately - fail fast if connection is broken
        if (!wsReady || ws.readyState !== WebSocket.WebSocket.OPEN) {
          if (retryCount < 2) {
            // Try reconnection once, but don't wait
            wsReady = false
            reconnectWebSocket()
              .then(() => {
                // Quick retry after reconnect
                sendWsRequest(message, retryCount + 1)
                  .then(resolve)
                  .catch(reject)
              })
              .catch(() => {
                reject(new Error('WebSocket connection failed'))
              })
          } else {
            reject(new Error('WebSocket not available'))
          }
          return
        }

        const id = Math.random().toString(36).substring(7)
        message.id = id
        pendingRequests.set(id, { resolve, reject })

        try {
          ws.send(JSON.stringify(message))
        } catch (error) {
          pendingRequests.delete(id)
          wsReady = false
          reject(new Error('Failed to send WebSocket message'))
          return
        }

        // Much shorter timeout - filesystem operations need to be fast
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id)

            if (retryCount < 1) {
              if (options.debug) {
                console.log(`🔄 Quick retry for:`, message.operation)
              }

              // Mark WebSocket as not ready to trigger fast reconnection
              wsReady = false
              sendWsRequest(message, retryCount + 1)
                .then(resolve)
                .catch(reject)
            } else {
              reject(new Error('Request timeout'))
            }
          }
        }, 1000) // Reduced to 1 second
      })
    }

    // Set up initial WebSocket connection with error handling
    const setupWebSocket = (socket: WebSocket.WebSocket) => {
      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const response = JSON.parse(data.toString())
          if (options.debug) {
            console.log('📨 Received:', response)
          }

          if (response.id && pendingRequests.has(response.id)) {
            const { resolve, reject } = pendingRequests.get(response.id)!
            pendingRequests.delete(response.id)

            if (response.success) {
              resolve(response)
            } else {
              reject(new Error(response.error || 'Unknown error'))
            }
          }
        } catch (error) {
          console.error('❌ Failed to parse WebSocket message:', error)
        }
      })

      socket.on('close', () => {
        console.log('🔌 WebSocket connection closed, will reconnect on next request')
        wsReady = false
      })

      socket.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message)
        wsReady = false
      })
    }

    setupWebSocket(ws)

    // Wait for WebSocket connection
    ws.on('open', () => {
      console.log('✅ WebSocket connection established')
      wsReady = true
      resolve({
        sendRequest: sendWsRequest,
        isReady: () => wsReady,
        close: () => ws.close(),
      })
    })

    ws.on('error', (error: Error) => {
      console.error('❌ WebSocket error:', error.message)
      reject(error)
    })
  })
}
