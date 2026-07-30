import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  // Electron launches one app instance per worker; serial keeps tmux state sane.
  workers: 1,
  fullyParallel: false,
})
