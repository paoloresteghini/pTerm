import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNELS } from '../../src/shared/ipc'
import { killServer, launchApp } from './harness'

/**
 * The update bar: that it appears when main says a release exists, that each
 * of its three buttons dismisses it, and that Skip reaches disk.
 *
 * No network. `PTERM_UPDATE_CHECK=0` (set for every spec in `harness.ts`)
 * keeps the scheduled check from ever running, and this file pushes the event
 * main would have pushed.
 *
 * **Sabotage, measured 2026-08-05:**
 * 1. `UpdateBar` returns `null`: 5 failed, 1 passed (only "no bar until"
 *    survives, as expected).
 * 2. `onSkip` in `App.tsx` drops the `skipUpdate` call: exactly the skip test
 *    fails, on the disk poll.
 * 3. `<UpdateBar>` moved above `<TitleBar />`: exactly the placement test
 *    fails.
 *
 * **What this file does NOT see:**
 *
 * - **the check itself.** Nothing here fetches, parses a release, compares
 *   versions or consults the skip file. All of that is
 *   `tests/unit/updateService.test.ts`;
 * - **the schedule.** The two timers in `src/main/update/schedule.ts` are
 *   switched off here, so neither the 10s first check nor the 6h interval is
 *   exercised by any test;
 * - **what Download opens.** See the note on that test below;
 * - **the Settings section.** `settings-pane` is never opened here; that is
 *   `tests/e2e/settingsUpdate.spec.ts`.
 */

const SOCKET = 'pterm-e2e-update'

const VERSION = '99.0.0'
const RELEASE_URL = 'https://github.com/paoloresteghini/PRCLI/releases/tag/v99.0.0'

let app: ElectronApplication
let configDir: string
let projectsRoot: string
let claudeHome: string
let userDataDir: string
let claudeSettings: string

test.beforeEach(async () => {
  await killServer(SOCKET)
  configDir = await mkdtemp(join(tmpdir(), 'pterm-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-projects-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-claude-'))
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-userdata-'))
  claudeSettings = join(claudeHome, 'settings.json')
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings,
    claudeHome,
    userDataDir,
  })
})

test.afterEach(async () => {
  await app.close().catch(() => undefined)
  await killServer(SOCKET)
  await Promise.all(
    [configDir, projectsRoot, claudeHome, userDataDir].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  )
})

/**
 * Push the event main's scheduler would have pushed.
 *
 * From main, not from the page: `contextBridge` freezes `window.pterm`, so no
 * spec can stub, delay or gate a bridge method. The channel is a literal here
 * because this callback is serialised into main and cannot import `CHANNELS`;
 * the assertion above it is what keeps the literal honest.
 */
async function pushUpdate(): Promise<void> {
  expect(CHANNELS.updateAvailable).toBe('pterm:updateAvailable')
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const [window] = BrowserWindow.getAllWindows()
      window.webContents.send('pterm:updateAvailable', payload)
    },
    { version: VERSION, url: RELEASE_URL },
  )
}

test('no bar until main says there is a release', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)
})

test('the bar names the version main pushed', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await expect(page.getByTestId('update-bar')).toBeVisible()
  // The version, not merely that a bar exists: a bar hardcoding a string would
  // pass a mere visibility check.
  await expect(page.getByTestId('update-version')).toHaveText(`pTerm ${VERSION} available`)
})

test('the bar sits below the title bar, not inside it', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await expect(page.getByTestId('update-bar')).toBeVisible()
  const titleBar = await page.getByTestId('titlebar').boundingBox()
  const bar = await page.getByTestId('update-bar').boundingBox()
  expect(titleBar).not.toBeNull()
  expect(bar).not.toBeNull()
  // Placement is the design decision this component exists to hold: inside the
  // title bar it would need `no-drag` on all three buttons. A geometric
  // assertion survives a restyle in a way a DOM-parent assertion would not.
  expect(bar!.y).toBeGreaterThanOrEqual(titleBar!.y + titleBar!.height - 1)
})

test('dismiss hides the bar', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await page.getByTestId('update-dismiss').click()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)
})

test('skip hides the bar and writes the version to disk', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await page.getByTestId('update-skip').click()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)

  // The disk half. Without it this test proves only that a button hides a div,
  // and the skip would silently stop persisting the day the handler broke.
  //
  // This push bypasses main's skip filter entirely (it goes straight to the
  // renderer's `webContents.send`, never through `check()`), so this test
  // proves only that clicking Skip reaches disk. The filter itself, that a
  // skipped version is reported as skipped rather than available, is covered
  // by `tests/unit/updateService.test.ts` ("reports a skipped version as
  // skipped, not available").
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(configDir, 'update.json'), 'utf8')) as unknown
      } catch {
        return null
      }
    })
    .toEqual({ skipped: VERSION })
})

/**
 * Download hides the bar. Whether it opened a browser is NOT asserted.
 *
 * `shell.openExternal` cannot be intercepted from a spec: Electron exposes
 * `shell`'s members as non-writable, so the monkeypatch a test would need
 * either throws or silently no-ops, and a test built on a patch that did not
 * install passes against a broken app. The remaining risk is one line,
 * `window.pterm.openExternal(update.url)` in `App.tsx`, whose scheme guard IS
 * covered by `tests/unit/openable.test.ts`.
 */
test('download hides the bar', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await page.getByTestId('update-download').click()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)
})
