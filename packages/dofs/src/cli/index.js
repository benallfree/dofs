#!/usr/bin/env node

import { Command } from 'commander'
const program = new Command()

program.name('dofs').description('A filesystem for Cloudflare Durable Objects').version('0.0.2')

program
  .command('init')
  .description('Initialize a new DOFS filesystem')
  .action(() => {
    console.log('Initializing DOFS filesystem...')
    // TODO: Implement init command
  })

program
  .command('mount')
  .description('Mount a DOFS filesystem')
  .option('-p, --path <path>', 'Mount path')
  .action((options) => {
    console.log('Mounting DOFS filesystem...', options)
    // TODO: Implement mount command
  })

program
  .command('status')
  .description('Show DOFS filesystem status')
  .action(() => {
    console.log('DOFS filesystem status:')
    // TODO: Implement status command
  })

program.parse()
