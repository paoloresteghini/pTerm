import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // One `npm run package` for the whole run. It used to be one per spec file,
  // in four separate `beforeAll` hooks.
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  // Electron launches one app instance per worker; serial keeps tmux state sane.
  workers: 1,
  fullyParallel: false,
})
