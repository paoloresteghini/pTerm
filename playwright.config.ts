import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // One `npm run package` for the whole run. It used to be one per spec file,
  // in four separate `beforeAll` hooks.
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  // Electron launches at least one full app instance per test — some launch
  // two (`launch.spec.ts:162`, `:169`). Each spec file already declares its
  // own tmux socket and kills only that socket on teardown (three of the
  // four also on setup), which today is what actually keeps two files' tmux
  // state apart, even if they ran in parallel. workers: 1 is insurance on
  // top of that: if two files ever came to share a socket, running them in
  // different workers would tear down each other's sessions, and serial
  // execution is what keeps that mistake from being able to bite.
  workers: 1,
  fullyParallel: false,
  // No retries. A flaky E2E test that passes on retry is a test that has
  // stopped saying anything — see projects.spec.ts for this suite's one
  // known pre-existing flake, which retries would only paper over.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    // Declared for the day a normal browser page enters this suite; today it
    // changes nothing. Every spec drives a window from `_electron.launch()`,
    // which never enters a `browserType`'s tracked `_contexts` (only
    // `browser.newContext()` does) and is still open when a failing
    // assertion throws, before the spec's own `app.close()` runs — so
    // neither of Playwright's on-failure capture paths produces anything for
    // it: `trace.zip` holds an action/timing log with no screencast frames,
    // and no screenshot file is written. Verified 2026-08-02: a deliberately
    // failed `launch.spec.ts` test left exactly `error-context.md` and
    // `trace.zip` under `test-results/`, no `.png`.
    screenshot: 'only-on-failure',
    // Belt-and-braces. These specs launch through `_electron.launch()`, whose
    // pages never reach the context fixture that applies `recordVideo`, so
    // `video: 'on'` would produce nothing here either. Explicit so that the
    // day a normal browser page enters the suite, it does not start writing
    // one video per test.
    video: 'off',
  },
})
