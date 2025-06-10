import { FuseErrno } from 'neofuse'
import { appendToFile, closeFile, createFileDescriptor, getFileInfo } from './file-descriptors.js'
import { createStat, processStatData } from './stats.js'
import {
  FuseCreateCallback,
  FuseGetattrCallback,
  FuseOpenCallback,
  FuseReaddirCallback,
  FuseReleaseCallback,
  FuseWriteCallback,
  MountOptions,
} from './types.js'
import { WebSocketManager } from './websocket.js'

export function createFuseOps(wsManager: WebSocketManager, options: MountOptions) {
  return {
    readdir: async (path: string, cb: FuseReaddirCallback) => {
      try {
        if (options.debug) {
          console.log(`📂 readdir: ${path}`)
        }

        if (path === '/') {
          // Request root directory listing from server
          const response = await wsManager.sendRequest({
            operation: 'readdir',
            path: '/',
          })

          cb(0, response.data)
        } else if (path.startsWith('/') && !path.includes('/', 1)) {
          // Top-level namespace directory (like /MY_DURABLE_OBJECT)
          // Request instance listing from server
          try {
            const response = await wsManager.sendRequest({
              operation: 'readdir',
              path: path,
            })

            if (response.success) {
              cb(0, response.data)
            } else {
              cb(FuseErrno.ENOENT)
            }
          } catch (error) {
            console.error('❌ readdir error for namespace:', error)
            cb(FuseErrno.EIO)
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
            const response = await wsManager.sendRequest({
              operation: 'getattr',
              path: path,
            })

            if (response.success) {
              const statData = processStatData(response.data)
              cb(0, statData)
            } else {
              cb(FuseErrno.ENOENT)
            }
          } catch (error) {
            // If server doesn't recognize the path, it's not found
            cb(FuseErrno.ENOENT)
          }
        } else if (path.startsWith('/')) {
          // Instance-level path like /NAMESPACE/INSTANCE-SLUG
          // Ask server to validate and get stat info
          try {
            const response = await wsManager.sendRequest({
              operation: 'getattr',
              path: path,
            })

            if (response.success) {
              const statData = processStatData(response.data)
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

    create: async (path: string, mode: number, cb: FuseCreateCallback) => {
      try {
        if (options.debug) {
          console.log(`✏️ create: ${path}, mode: ${mode}`)
        }

        // Check if this is a valid path (should be /NAMESPACE/INSTANCE/filename)
        const pathParts = path.split('/').filter((part) => part.length > 0)

        if (pathParts.length >= 3) {
          // Create a file descriptor and track the file
          const fd = createFileDescriptor(path)
          cb(0, fd)
        } else {
          // Prohibit writing to root (/) or namespace directories (/NAMESPACE)
          if (options.debug) {
            console.log(
              `❌ create denied: cannot write files to ${pathParts.length === 0 ? 'root directory' : 'namespace directory'} (${path})`
            )
          }
          cb(FuseErrno.EACCES) // Permission denied for invalid paths
        }
      } catch (error) {
        console.error('❌ create error:', error)
        cb(FuseErrno.EIO)
      }
    },

    open: async (path: string, flags: number, cb: FuseOpenCallback) => {
      try {
        if (options.debug) {
          console.log(`📖 open: ${path}, flags: ${flags}`)
        }

        // Check if this is a valid path for file operations (should be /NAMESPACE/INSTANCE/filename)
        const pathParts = path.split('/').filter((part) => part.length > 0)

        if (pathParts.length >= 3) {
          const fd = createFileDescriptor(path)
          cb(0, fd)
        } else {
          // Prohibit opening files at root (/) or namespace directories (/NAMESPACE)
          if (options.debug) {
            console.log(
              `❌ open denied: cannot open files at ${pathParts.length === 0 ? 'root directory' : 'namespace directory'} (${path})`
            )
          }
          cb(FuseErrno.EACCES) // Permission denied for invalid paths
        }
      } catch (error) {
        console.error('❌ open error:', error)
        cb(FuseErrno.EIO)
      }
    },

    write: async (
      path: string,
      fd: number,
      buffer: Buffer,
      length: number,
      position: number,
      cb: FuseWriteCallback
    ) => {
      try {
        if (options.debug) {
          console.log(`✍️ write: ${path}, fd: ${fd}, length: ${length}, position: ${position}`)
        }

        const fileInfo = getFileInfo(fd)
        if (!fileInfo) {
          cb(FuseErrno.EBADF) // Bad file descriptor
          return
        }

        // For simplicity, append the data to our buffer (ignore position for now)
        const writeData = buffer.slice(0, length)
        appendToFile(fd, writeData)

        cb(0, length) // Return number of bytes written
      } catch (error) {
        console.error('❌ write error:', error)
        cb(FuseErrno.EIO)
      }
    },

    release: async (path: string, fd: number, cb: FuseReleaseCallback) => {
      try {
        if (options.debug) {
          console.log(`🔒 release: ${path}, fd: ${fd}`)
        }

        const fileInfo = getFileInfo(fd)
        if (!fileInfo) {
          cb(0) // Already closed
          return
        }

        // Send the file data to the server
        try {
          const writeMessage = {
            operation: 'write',
            path: path, // Send the full absolute path for server-side parsing
            content: fileInfo.data.toString('base64'),
            encoding: 'base64',
          }

          if (options.debug) {
            console.log(`🔍 CLIENT: Sending write message:`, JSON.stringify(writeMessage, null, 2))
          }

          const response = await wsManager.sendRequest(writeMessage)

          if (options.debug) {
            console.log(`🔍 CLIENT: Received response:`, JSON.stringify(response, null, 2))
          }

          if (response.success) {
            if (options.debug) {
              console.log(`✅ File written: ${path}`)
            }
          } else {
            console.error(`❌ Failed to write file: ${response.error}`)
          }
        } catch (error) {
          console.error('❌ Error sending file to server:', error)
        }

        // Clean up file descriptor
        closeFile(fd)
        cb(0)
      } catch (error) {
        console.error('❌ release error:', error)
        cb(FuseErrno.EIO)
      }
    },
  }
}
