#!/usr/bin/env node

import { Command } from 'commander'
import * as fs from 'fs'
import Fuse, { FuseErrno } from 'neofuse'
import * as path from 'path'
import * as WebSocket from 'ws'
import pkg from '../../package.json' with { type: 'json' }

const program = new Command()

program.name('dofs').description('A filesystem for Cloudflare Durable Objects').version(pkg.version)

// Helper function to create stat objects
function createStat(options: { mode: 'file' | 'dir'; size?: number }) {
  return {
    mtime: new Date(),
    atime: new Date(),
    ctime: new Date(),
    nlink: 1,
    size: options.size || 0,
    mode: options.mode === 'dir' ? 16877 : 33188, // 0o40755 for dir, 0o100644 for file
    uid: process.getuid ? process.getuid() : 0,
    gid: process.getgid ? process.getgid() : 0,
  }
}

// Define correct callback types for neofuse
type FuseReaddirCallback = (err: number, files?: string[]) => void
type FuseGetattrCallback = (err: number, stat?: any) => void

program
  .command('init')
  .description('Initialize a new DOFS filesystem')
  .action(() => {
    console.log('Initializing DOFS filesystem...')
    // TODO: Implement init command
  })

program
  .command('mount <endpoint>')
  .description('Mount a DOFS filesystem')
  .option('-m, --mount-point <path>', 'Mount point directory', './mnt')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (endpoint: string, options: { mountPoint: string; debug?: boolean }) => {
    console.log(`Mounting DOFS from ${endpoint} to ${options.mountPoint}`)

    try {
      // Ensure mount point exists
      if (!fs.existsSync(options.mountPoint)) {
        fs.mkdirSync(options.mountPoint, { recursive: true })
        console.log(`📁 Created mount point: ${options.mountPoint}`)
      }

      // Convert HTTP endpoint to WebSocket endpoint
      const wsEndpoint = endpoint.replace(/^https?:\/\//, 'ws://').replace(/\/$/, '') + '/ws'
      console.log(`Connecting to WebSocket: ${wsEndpoint}`)

      const ws = new WebSocket.WebSocket(wsEndpoint)
      let wsReady = false
      const pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()

      // WebSocket message handler
      ws.on('message', (data: WebSocket.RawData) => {
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

      // Helper function to send WebSocket requests
      const sendWsRequest = (message: any): Promise<any> => {
        return new Promise((resolve, reject) => {
          if (!wsReady) {
            reject(new Error('WebSocket not ready'))
            return
          }

          const id = Math.random().toString(36).substring(7)
          message.id = id
          pendingRequests.set(id, { resolve, reject })

          ws.send(JSON.stringify(message))

          // Timeout after 10 seconds
          setTimeout(() => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id)
              reject(new Error('Request timeout'))
            }
          }, 10000)
        })
      }

      // FUSE operations
      const fuseOps = {
        readdir: async (path: string, cb: FuseReaddirCallback) => {
          try {
            if (options.debug) {
              console.log(`📂 readdir: ${path}`)
            }

            if (path === '/') {
              // Request root directory listing from server
              const response = await sendWsRequest({
                operation: 'readdir',
                path: '/',
              })

              cb(0, response.data)
            } else if (path.startsWith('/') && !path.includes('/', 1)) {
              // Top-level namespace directory (like /MY_DURABLE_OBJECT)
              // For now, return empty directory since we haven't implemented instances yet
              // TODO: In the future, we'll call getInstances() and return actual DO instances
              const namespaceName = path.substring(1)

              // First verify this namespace exists by asking the server
              try {
                const response = await sendWsRequest({
                  operation: 'getattr',
                  path: path,
                })

                if (response.success) {
                  // Valid namespace, return empty directory for now
                  cb(0, [])
                } else {
                  cb(FuseErrno.ENOENT)
                }
              } catch (error) {
                cb(FuseErrno.ENOENT)
              }
            } else {
              cb(FuseErrno.ENOENT) // Not found
            }
          } catch (error) {
            console.error('❌ readdir error:', error)
            cb(FuseErrno.EIO) // I/O error
          }
        },

        getattr: async (path: string, cb: FuseGetattrCallback) => {
          try {
            if (options.debug) {
              console.log(`📋 getattr: ${path}`)
            }

            if (path === '/') {
              // Root directory
              cb(0, createStat({ mode: 'dir', size: 4096 }))
            } else if (path.startsWith('/') && !path.includes('/', 1)) {
              // Top-level entry - should be a namespace directory
              // We need to check with the server if this namespace exists
              try {
                const response = await sendWsRequest({
                  operation: 'getattr',
                  path: path,
                })

                if (response.success) {
                  // Convert date strings back to Date objects (JSON serialization converts Dates to strings)
                  const statData = response.data
                  if (statData.mtime && typeof statData.mtime === 'string') {
                    statData.mtime = new Date(statData.mtime)
                  }
                  if (statData.atime && typeof statData.atime === 'string') {
                    statData.atime = new Date(statData.atime)
                  }
                  if (statData.ctime && typeof statData.ctime === 'string') {
                    statData.ctime = new Date(statData.ctime)
                  }

                  cb(0, statData)
                } else {
                  cb(FuseErrno.ENOENT)
                }
              } catch (error) {
                // If server doesn't recognize the path, it's not found
                cb(FuseErrno.ENOENT)
              }
            } else {
              // Deeper paths not implemented yet
              cb(FuseErrno.ENOENT)
            }
          } catch (error) {
            console.error('❌ getattr error:', error)
            cb(FuseErrno.EIO)
          }
        },
      }

      // Wait for WebSocket connection
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          console.log('✅ WebSocket connection established')
          wsReady = true
          resolve()
        })

        ws.on('error', (error: Error) => {
          console.error('❌ WebSocket error:', error.message)
          reject(error)
        })
      })

      // Create and mount FUSE filesystem
      const absoluteMountPoint = path.resolve(options.mountPoint)
      const fuse = new Fuse(absoluteMountPoint, fuseOps, {
        debug: options.debug,
        force: true,
      })

      console.log(`🔗 Mounting FUSE filesystem at: ${absoluteMountPoint}`)

      fuse.mount((err?: Error) => {
        if (err) {
          console.error('❌ Failed to mount FUSE filesystem:', err.message)
          process.exit(1)
        }

        console.log('✅ FUSE filesystem mounted successfully!')
        console.log(`📁 You can now access the filesystem at: ${absoluteMountPoint}`)
        console.log('💡 Try: ls ' + absoluteMountPoint)
      })

      // Cleanup on exit
      process.on('SIGINT', () => {
        console.log('\n🛑 Unmounting filesystem...')
        fuse.unmount(() => {
          ws.close()
          console.log('✅ Filesystem unmounted')
          process.exit(0)
        })
      })
    } catch (error) {
      console.error('❌ Failed to mount:', error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  })

program
  .command('status')
  .description('Show DOFS filesystem status')
  .action(() => {
    console.log('DOFS filesystem status:')
    // TODO: Implement status command
  })

program.parse()
