import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/DurableObjectFs.ts'],
  format: ['esm'],
  dts: true,
  external: ['cloudflare:workers'],
  outDir: 'dist',
  clean: true,
}) 