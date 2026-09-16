import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vite picks 5173 and walks upward when it is busy, which is fine until two
  // dev instances are running and neither says which port it took. Naming it
  // makes a second instance explicit: PTERM_DEV_PORT=5273 npm start.
  server: {
    port: Number(process.env.PTERM_DEV_PORT ?? 5173),
    strictPort: process.env.PTERM_DEV_PORT !== undefined,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
