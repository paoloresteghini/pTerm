import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      // node-pty is a native module — it must be require()d at runtime,
      // never bundled. Bundling it produces "Cannot find module ...node".
      external: ['node-pty'],
    },
  },
})
