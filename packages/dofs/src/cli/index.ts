#!/usr/bin/env node

import { Command } from 'commander'
import * as WebSocket from 'ws'
import pkg from '../../package.json'

const program = new Command()

program.name('dofs').description('A filesystem for Cloudflare Durable Objects').version(pkg.version)

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
      // Convert HTTP endpoint to WebSocket endpoint
      const wsEndpoint = endpoint.replace(/^https?:\/\//, 'ws://').replace(/\/$/, '') + '/ws'

      console.log(`Connecting to WebSocket: ${wsEndpoint}`)

      const ws = new WebSocket.WebSocket(wsEndpoint)

      ws.on('open', () => {
        console.log('✅ WebSocket connection established')

        // Send a test message
        ws.send(
          JSON.stringify({
            type: 'test',
            message: 'Hello from dofs mount!',
          })
        )
      })

      ws.on('message', (data: WebSocket.RawData) => {
        const message = data.toString()
        console.log('📨 Received:', message)
      })

      ws.on('error', (error: Error) => {
        console.error('❌ WebSocket error:', error.message)
        process.exit(1)
      })

      ws.on('close', () => {
        console.log('🔌 WebSocket connection closed')
        process.exit(0)
      })

      // Keep the process alive
      process.on('SIGINT', () => {
        console.log('\n🛑 Unmounting filesystem...')
        ws.close()
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
