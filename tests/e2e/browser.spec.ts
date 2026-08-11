/**
 * The browser pane, end to end.
 *
 * Written against `.superpowers/sdd/2026-08-11-browser-pane-m1/task-9-brief.md`
 * and the spike it names,
 * `docs/superpowers/notes/2026-08-11-playwright-webview-reach.md`. That note
 * is a measured fact, not a starting guess: `page.frames()` lists a browser
 * pane's guest but always reports its url as `about:blank`, and
 * `page.frameLocator(...)` throws outright ("`<webview>`, `<iframe>` was
 * expected"). The only mechanism that reaches page content is main-side,
 * through `electronApp.evaluate`, filtering `webContents.getAllWebContents()`
 * by `getType() === 'webview'` and calling `executeJavaScript` on the guest
 * that survives the filter. `guestText`/`guestUrl`/`clickInGuest` below are
 * that mechanism, reused across every test that needs to see inside a pane.
 * Every pane-level assertion (chrome, the address bar, the failure card) goes
 * through the ordinary `page.getByTestId(...)` route instead, since none of
 * that is inside the guest.
 *
 * Each test here mounts exactly one browser pane, so the "exactly one guest"
 * check inside those three helpers is a sanity check on this file's own
 * setup, not real disambiguation. A spec that mounted two at once (this app
 * keeps every pane mounted regardless of which project is active, so that is
 * a real possibility elsewhere) would need to match on `getURL()` or on the
 * pane's `partition` instead, per the spike note's own closing paragraph.
 *
 * Modelled on `editorRestore.spec.ts`, the closest sibling: a sessionless
 * pane across a relaunch is most of what this needs too, and the same
 * "seed rather than drive the UI" reasoning applies wherever the UI has no
 * route to the state a test needs.
 *
 * Three corrections against the brief this file was written from, each
 * measured rather than assumed:
 *
 * - The brief expected `http://localhost:1` to fail with connection-refused
 *   (-102). Measured 2026-08-11: it is -312, `ERR_UNSAFE_PORT`. Chromium
 *   refuses port 1 as an unsafe port before it ever dials anything, which is
 *   a different guard from a real connection failing. The failure-card test
 *   below does not pin either number, on purpose: it asserts the card and its
 *   Retry button appear, which is the only part of this the brief actually
 *   needs and the only part that is not tied to Chromium's own port list.
 * - The brief's step 4 (delete `attachSavedFields`'s `url` line, expect the
 *   relaunch test to fail) assumed the answer. It is not assumed here: the
 *   measured result is recorded on the relaunch test itself, verbatim,
 *   because a plan that predicts a mutation's outcome and is wrong produces a
 *   record that reads like proof while documenting a no-op, the exact
 *   failure mode `savedFields.ts`'s own header already warns about for
 *   `filePath`.
 * - A third failure state (a hung page, no `did-fail-load` and no
 *   `render-process-gone`) was cut from M1 partway through. Nothing here
 *   tests it.
 *
 * `a browser pane splits beside a terminal` (the brief's item 4) turned out
 * to have no route through the product's own UI or IPC surface at all, which
 * is itself worth recording. `splitActive` (`App.tsx`) refuses to split from
 * a pane with no `grid` entry, and `paneGrid` (`Terminal.tsx`) only ever
 * holds an entry for a mounted xterm terminal (a browser pane has none), so
 * the "Split" menu item is a no-op on one. Calling `CHANNELS.splitPane`
 * directly does not route around that either: `SessionManager.splitTab`
 * attaches the new window `through: sibling.record.tmuxSession`, and a
 * browser pane is never registered with `SessionManager` at all (`openBrowser`
 * in `register.ts` writes straight to `store`, with no `manager.open()` call
 * anywhere in it), so a browser pane is not a valid split origin down at the
 * session-manager layer either, not only up at the renderer's grid check.
 * The test below builds the mixed tab by seeding instead: a real terminal
 * pane and tab row, made by the app itself through `new-tab`, then a browser
 * pane row added to the same tab's `kids` between two launches, the same
 * shape `editorRestore.spec.ts`'s `seedDeadTerminal` already uses to modify
 * config between two real runs, except the added row here is a normal live
 * sibling rather than a corpse meant to be pruned.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-browser'
const FIXTURE_URL = pathToFileURL(join(__dirname, 'fixtures', 'browser-page.html')).href

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-browser-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-browser-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-browser-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-browser-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-browser-claude-'))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 9,
      // `slug` is required: `isProject` drops a project row without one.
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      panes: [],
      tabs: [],
      activeProjectId: 'p1',
    }),
    'utf8',
  )
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Config as it stands on disk right now. */
interface DiskConfig {
  panes: { id: string; type: string; url?: string }[]
  tabs: { id: string; layout: { dir: string; ratio: number[]; kids: string[] } }[]
}
async function readConfig(): Promise<DiskConfig> {
  return JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
}
async function savedUrl(id: string): Promise<string | undefined> {
  return (await readConfig()).panes.find((row) => row.id === id)?.url
}

/**
 * Opens a fresh browser pane through the real palette command, and returns
 * its pane id (read off the tab the palette's `choose()` selects, the same
 * way `paletteFiles.spec.ts` reads a just-opened editor's tab id: there is
 * only ever one tab in this file's project when this is called, so the last
 * `tab-` testid on screen is unambiguous).
 */
async function openBrowserPane(page: Page): Promise<string> {
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.getByTestId('palette-input').fill('New browser pane')
  await page.getByTestId('palette-command-New browser pane').click()
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  const testId = (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  const id = testId.replace('tab-', '')
  // A real state change (nothing named this id existed before the click),
  // not an already-true assertion.
  await expect(page.getByTestId(`browserpane-${id}`)).toBeVisible({ timeout: 20_000 })
  return id
}

/**
 * The URL of the one live browser-pane guest, or null if there is not exactly
 * one. `webContents.getAllWebContents()` filtered by `getType() === 'webview'`
 * is the mechanism the spike measured; the "exactly one" check is this file's
 * own guard against silently picking the wrong pane if a test ever mounts
 * more than one.
 */
async function guestUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
    return guests.length === 1 ? guests[0]!.getURL() : null
  })
}

/** `selector`'s `textContent` inside the one live guest, or null if there is
 * not exactly one guest or the selector matches nothing (including while the
 * guest is still on `about:blank`, before a real navigation lands). Pollable
 * for exactly that reason. */
async function guestText(app: ElectronApplication, selector: string): Promise<string | null> {
  return app.evaluate(async ({ webContents }, sel) => {
    const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
    if (guests.length !== 1) return null
    return guests[0]!.executeJavaScript(`document.querySelector('${sel}')?.textContent ?? null`)
  }, selector)
}

/**
 * Clicks `selector` inside the one live guest, with a real user gesture.
 *
 * The second argument to `executeJavaScript` (`userGesture`), not a bare
 * `element.click()`: a scripted click carries no user activation, and
 * Chromium refuses a popup for that reason alone, before
 * `setWindowOpenHandler` in `src/main/index.ts` is ever asked. Measured
 * during this file's own development: losing a run to a click that did
 * nothing because this argument was missing.
 */
async function clickInGuest(app: ElectronApplication, selector: string): Promise<void> {
  await app.evaluate(async ({ webContents }, sel) => {
    const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
    if (guests.length !== 1) {
      throw new Error(`clickInGuest: expected exactly one browser guest, found ${guests.length}`)
    }
    await guests[0]!.executeJavaScript(`document.querySelector('${sel}')?.click()`, true)
  }, selector)
}

/**
 * A throwaway HTTP server on an OS-assigned port, serving two pages: `/`
 * links to `/dest` with `target="_blank"`, and `/dest` is the destination.
 *
 * A local server rather than a public URL: there may be no network in the
 * environment this runs in, and `file://` would not pass the http/https guard
 * `setWindowOpenHandler` applies before it calls `loadURL`.
 */
function startPopupServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html')
      if (req.url === '/dest') {
        res.end(
          '<!doctype html><title>Popup destination</title>' +
            '<h1 id="dest-marker">popup-destination-loaded</h1>',
        )
        return
      }
      res.end(
        '<!doctype html><title>Popup source</title>' +
          '<h1 id="src-marker">popup-source-loaded</h1>' +
          '<a id="popup-link" href="/dest" target="_blank">go</a>',
      )
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('startPopupServer: no port assigned'))
        return
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

test('the palette command opens a browser pane, and the pane chrome is present', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  const id = await openBrowserPane(page)

  await expect(page.getByTestId(`browserurl-${id}`)).toHaveValue('about:blank')
  await expect(page.getByTestId(`browserback-${id}`)).toBeVisible()
  await expect(page.getByTestId(`browserforward-${id}`)).toBeVisible()
  await expect(page.getByTestId(`browserreload-${id}`)).toBeVisible()
  await expect(page.getByTestId(`browserdevtools-${id}`)).toBeVisible()
  await expect(page.getByTestId(`browserview-${id}`)).toBeVisible()

  await app.close()
})

test('typing a file:// URL and pressing Enter loads it', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  const id = await openBrowserPane(page)

  const bar = page.getByTestId(`browserurl-${id}`)
  await bar.fill(FIXTURE_URL)
  await bar.press('Enter')

  // Content, through the one mechanism the spike measured to work, not
  // through the address bar's own value: `.fill()` already sets that value
  // before Enter is ever pressed, so asserting it here would be an
  // already-true assertion proving nothing about whether the navigation
  // itself happened.
  await expect
    .poll(() => guestText(app, '#marker'), { timeout: 10_000 })
    .toBe('browser-pane-fixture-loaded')

  await app.close()
})

/**
 * The highest-value test in this file: whether a browser pane's URL survives
 * a relaunch.
 *
 * **Measured 2026-08-11, deleting `if (row.url) next.url = row.url` from
 * `attachSavedFields` (`src/main/ipc/savedFields.ts`) and rerunning this test
 * alone: it passed.** Nothing failed. That is a finding about this test, not
 * a clean bill of health for the line: reading `mergeSessionlessPanes`
 * (`src/main/ipc/sessionlessPanes.ts`) shows why. A browser pane is
 * sessionless, so on restore it never comes back through `livePanes` at
 * all, `mergeSessionlessPanes` puts the SAVED pane row itself into the
 * merged list (`if (placed.has(saved.id)) panes.push(saved)`), url and all,
 * and `attachSavedFields` then runs `{ ...pane }` over a `pane` that is
 * already that exact saved row. The `url` line has nothing left to do by the
 * time it runs, on this path, today. This is the same situation
 * `savedFields.ts`'s own header already documents for `filePath`, reached
 * independently here for `url`: `tests/unit/savedFields.test.ts` ("carries
 * url onto a record that does not carry one") is where this line is actually
 * exercised, by calling `attachSavedFields` directly on a built record that
 * does NOT already carry the field, which is the situation only a different
 * producer than today's `mergeSessionlessPanes` would create. This e2e test
 * still earns its place: it is real, end-to-end proof that a browser pane's
 * URL survives `app.close()` and a relaunch, which is the user-visible claim
 * the brief asked for, and Correction 2 in this file's own header is what
 * asked for this paragraph to say so plainly rather than assume it.
 */
test('the URL survives app.close() and a relaunch', async () => {
  const first = await launch()
  const opened = await first.firstWindow()
  await expect(opened.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  const id = await openBrowserPane(opened)

  const bar = opened.getByTestId(`browserurl-${id}`)
  await bar.fill(FIXTURE_URL)
  await bar.press('Enter')
  await expect.poll(() => guestText(first, '#marker'), { timeout: 10_000 }).toBe(
    'browser-pane-fixture-loaded',
  )

  // `createUrlSync` (`urlSync.ts`) debounces the write 500ms and, by its own
  // header, deliberately has no flush on quit: "the write this exists for
  // must never fire once the pane it names is gone" is about `cancel`, not
  // about delivering early. Closing right after the content poll above would
  // race that timer, so this waits on disk for the write itself instead of on
  // a fixed sleep standing in for it.
  await expect.poll(() => savedUrl(id), { timeout: 5_000 }).toBe(FIXTURE_URL)

  await first.close()

  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId(`browserpane-${id}`)).toBeVisible({ timeout: 20_000 })
  // The saved value reaching the restored pane's own construction (`address`,
  // read once from `url` on mount): see this test's own header for the
  // measured result of deleting the line that puts it there.
  await expect(reopened.getByTestId(`browserurl-${id}`)).toHaveValue(FIXTURE_URL, { timeout: 10_000 })
  // And the restored pane actually loaded the page, not merely remembered
  // its address.
  await expect
    .poll(() => guestText(second, '#marker'), { timeout: 10_000 })
    .toBe('browser-pane-fixture-loaded')

  await second.close()
})

/**
 * A browser pane and a terminal, laid out side by side in one tab.
 *
 * See this file's own header for why the terminal is made by the app itself
 * (`new-tab`, a real tmux session) and the browser pane is added to its tab
 * row by hand, between two launches, rather than driven through the UI or
 * IPC: neither route exists for a browser pane to end up as a split's new
 * member or its origin.
 */
test('a browser pane and a terminal split one tab and both are laid out', async () => {
  const first = await launch()
  const opened = await first.firstWindow()
  await expect(opened.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await opened.getByTestId('new-tab').click()
  await expect(opened.getByTestId('terminal-active')).toBeVisible()
  const tabTestId = (await opened.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  const termId = tabTestId.replace('tab-', '')
  // Written by the real `open` handler before its reply resolves; polled
  // rather than read once so this does not race that write.
  await expect.poll(async () => (await readConfig()).panes.some((row) => row.id === termId)).toBe(true)

  await first.close()

  // Read and patched as loose JSON rather than through `readConfig`/
  // `DiskConfig`: those two only carry the fields the other tests in this
  // file read back, and a browser pane row needs `projectSlug` and `cwd`
  // besides, for `isProject`/`describeProjects` to resolve it to anything at
  // all.
  const config = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  config.panes.push({ id: 'b1', projectSlug: 'demo', cwd: projectCwd, type: 'browser', url: 'about:blank' })
  // A tab with no split of its own has no row here at all. `splits.spec.ts`
  // documents the same thing for the same reason: `tabs: []` is seeded and
  // `CHANNELS.open` adds none, only `CHANNELS.splitPane` and restore do. So
  // this tab's row is made here rather than found, the same `TabRow` shape
  // `editorRestore.spec.ts` seeds by hand for the same reason.
  let tab = config.tabs.find((row: { id: string }) => row.id === termId)
  if (!tab) {
    tab = { id: termId, groupId: termId, activePaneId: termId, layout: { dir: 'row', ratio: [1], kids: [termId] } }
    config.tabs.push(tab)
  }
  tab.layout = { dir: 'row', ratio: [0.5, 0.5], kids: [termId, 'b1'] }
  await writeFile(join(configDir, 'config.json'), JSON.stringify(config), 'utf8')

  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId(`pane-${termId}`)).toBeVisible({ timeout: 20_000 })
  await expect(reopened.getByTestId('browserpane-b1')).toBeVisible({ timeout: 20_000 })

  const termBox = await reopened.getByTestId(`pane-${termId}`).boundingBox()
  const browserBox = await reopened.getByTestId('pane-b1').boundingBox()
  expect(termBox).not.toBeNull()
  expect(browserBox).not.toBeNull()
  // Both boxes hold real width, not a sliver either the split refused or the
  // layout collapsed to nothing.
  expect(termBox!.width).toBeGreaterThan(100)
  expect(browserBox!.width).toBeGreaterThan(100)
  // Roughly the 0.5/0.5 ratio seeded above, not pinned to an exact pixel
  // count: this tab's width is whatever is left of the window after the
  // app's other chrome, which this test does not own.
  expect(Math.abs(termBox!.width - browserBox!.width)).toBeLessThan(20)
  // Side by side, in the seeded order, not stacked or overlapping.
  expect(browserBox!.x).toBeGreaterThanOrEqual(termBox!.x + termBox!.width - 2)

  await second.close()
})

test('navigating to an unsafe port shows the failure card with a working Retry button', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  const id = await openBrowserPane(page)

  const bar = page.getByTestId(`browserurl-${id}`)
  await bar.fill('http://localhost:1')
  await bar.press('Enter')

  // A real change: no card exists at `about:blank`, and `did-fail-load` has
  // to actually fire, and pass `isRealLoadFailure`, for one to appear.
  //
  // Not asserted on the numeric code: measured 2026-08-11, this is -312
  // (`ERR_UNSAFE_PORT`, Chromium refusing port 1 before it dials anything),
  // not the -102 (connection refused) the brief this file was written from
  // assumed. See this file's own header for the full correction. The card and
  // its Retry button are what the brief actually needs, and neither depends
  // on which of Chromium's own error codes produced them.
  await expect(page.getByTestId(`browsererror-${id}`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`browsererror-${id}`)).toContainText('Failed to load')
  await expect(page.getByTestId(`browsererrorretry-${id}`)).toBeVisible()
  await expect(page.getByTestId(`browsererrorretry-${id}`)).toBeEnabled()

  await app.close()
})

/**
 * A `target=_blank` click loads in the SAME guest, and opens no second
 * window.
 *
 * This is a mitigation test, not an ordinary feature test. `disablePopups` in
 * `src/main/index.ts` is set through a cast (`(webPreferences as
 * WebPreferences & { disablePopups?: boolean })`), because the field is not
 * in Electron's own `.d.ts`. A cast like that swallows a rename or a removal
 * silently: nothing in `tsc --noEmit` would catch a future Electron dropping
 * or renaming it, and the app would keep compiling while every popup in every
 * browser pane started silently doing nothing (or, worse, opening a real
 * window this app has no chrome for). This test is the one thing that would
 * catch that: it exercises the real effect of the field working, not the
 * field's presence, so it fails the same way whether the field disappears,
 * gets renamed, or Electron changes what it does.
 */
test('a target=_blank click loads in place and opens no window', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  const id = await openBrowserPane(page)

  const { server, baseUrl } = await startPopupServer()
  try {
    const bar = page.getByTestId(`browserurl-${id}`)
    await bar.fill(baseUrl)
    await bar.press('Enter')
    await expect
      .poll(() => guestText(app, '#src-marker'), { timeout: 10_000 })
      .toBe('popup-source-loaded')

    const windowsBefore = app.windows().length

    // DevTools is never opened anywhere in this test. A DevTools window is
    // its own entry in `app.windows()`, and opening one here would inflate
    // the count below into a false failure regardless of whether the popup
    // itself was handled correctly.
    await clickInGuest(app, '#popup-link')

    await expect
      .poll(() => guestText(app, '#dest-marker'), { timeout: 10_000 })
      .toBe('popup-destination-loaded')
    await expect.poll(() => guestUrl(app), { timeout: 10_000 }).toBe(`${baseUrl}/dest`)

    // The mitigation itself: no second window, checked only after the
    // navigation above is confirmed, so Chromium has already had every
    // chance it is going to get to open one.
    expect(app.windows().length).toBe(windowsBefore)
  } finally {
    server.close()
  }

  await app.close()
})
