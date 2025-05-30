import { copyFileSync } from 'fs'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/Fs.ts', 'src/hono/index.ts'],
  format: ['esm'],
  dts: true,
  external: ['cloudflare:workers'],
  outDir: 'dist',
  clean: true,
  onSuccess: async () => {
    console.log('Copying README.md to root')
    copyFileSync('README.md', '../../README.md')
  },
})
