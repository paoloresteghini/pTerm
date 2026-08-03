import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // One `npm run package` for the whole run. It used to be one per spec file,
  // in four separate `beforeAll` hooks.
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  // Electron launches a full app instance per test. Serial execution is what
  // actually keeps two spec files from tearing down each other's tmux
  // sessions: every file kills its own tmux server (`-L <socket>`) on
  // teardown, three of the four also on setup, and while harness.ts gives
  // each file its own socket today, workers: 1 is what makes it safe to stop
  // remembering that.
  workers: 1,
  fullyParallel: false,
  // No retries. A flaky E2E test that passes on retry is a test that has
  // stopped saying anything, and this repo has twenty of those already.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Explicit rather than defaulted: an Electron video is large, and a
    // suite that writes one per test is a suite people stop running.
    video: 'off',
  },
})
