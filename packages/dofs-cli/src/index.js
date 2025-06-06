#!/usr/bin/env node

import { Command } from 'commander'

const program = new Command()

program.name('dofs').description('DOFS CLI tool').version('0.0.1')

program
  .command('mount')
  .description('Mount a filesystem')
  .action(() => {
    // Mount command implementation will go here
  })

program.parse()
