/// <reference types="node" />

import { copyFileSync } from 'fs'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    hono: 'src/hono/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: ['esm'],
  dts: {
    sourcemap: true,
  },
  sourcemap: true,
  external: ['cloudflare:workers'],
  outDir: 'dist',
  clean: true,
  onSuccess: async () => {
    console.log('Copying README.md to root')
    copyFileSync('README.md', '../../README.md')
  },
})
