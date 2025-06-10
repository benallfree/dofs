import { Command } from 'commander'
import * as fs from 'fs'
import Fuse from 'neofuse'
import * as path from 'path'
import { createFuseOps } from './fuse-ops.js'
import { MountOptions } from './types.js'
import { createWebSocketManager } from './websocket.js'

export function setupCommands(program: Command) {
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
    .action(async (endpoint: string, options: MountOptions) => {
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

        // Create WebSocket manager
        const wsManager = await createWebSocketManager(wsEndpoint, options)

        // Create FUSE operations
        const fuseOps = createFuseOps(wsManager, options)

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
            wsManager.close()
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
}
