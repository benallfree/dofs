import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/Fs.ts'],
  format: ['esm'],
  dts: true,
  external: ['cloudflare:workers'],
  outDir: 'dist',
  clean: true,
})
