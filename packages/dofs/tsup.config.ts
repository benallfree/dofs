import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/Fs.ts', 'src/hono/index.ts'],
  format: ['esm'],
  dts: true,
  external: ['cloudflare:workers'],
  outDir: 'dist',
  clean: true,
})
