#!/usr/bin/env node

import { Command } from 'commander'
import pkg from '../../package.json' with { type: 'json' }
import { setupCommands } from './commands.js'

const program = new Command()

program.name('dofs').description('A filesystem for Cloudflare Durable Objects').version(pkg.version)

setupCommands(program)

program.parse()
