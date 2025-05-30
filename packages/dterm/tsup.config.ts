import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    vanilla: 'src/vanilla/index.ts',
  },
  format: ['esm'],
  dts: true,
  external: ['cloudflare:workers', 'hono'],
  outDir: 'dist',
  clean: true,
  splitting: false, // Keep as true if you prefer code splitting, false for separate bundles per entry
  // To ensure hono.js and vanilla.js are top-level in dist:
  // tsup typically creates `dist/hono.js` and `dist/vanilla.js` from the entry object keys
})
