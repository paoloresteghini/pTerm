/**
 * The browser region on screen: a column of its own, with a bar of its own.
 *
 * Set up like `tests/e2e/browser.spec.ts`, which this borrows its palette
 * route from: one app per test, its own tmux socket, and a fresh user data
 * directory so no stored column width or collapse flag leaks in from another
 * run. Everything asserted here is host-side chrome. Nothing reads inside a
 * browser pane's guest, which Playwright cannot reach: `page.frames()` reports
 * the guest as `about:blank` and `frameLocator` throws outright (see that
 * file's header for the measurement).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-browserregion'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let otherCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let probeUrl: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-region-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-region-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-region-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-region-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-region-claude-'))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })
  otherCwd = join(projectsRoot, 'other')
  await mkdir(otherCwd, { recursive: true })

  // A page with a body tall enough to scroll and a fresh `__nonce` per load,
  // which is what lets the collapse test below tell a page that survived
  // from a page that was rebuilt from the same URL. Written per test rather
  // than kept in `tests/e2e/fixtures/`: it exists to be read back through
  // the guest, not to be looked at.
  const probePath = join(projectCwd, 'browser-region-probe.html')
  await writeFile(
    probePath,
    `<!doctype html><title>probe</title>
     <body style="margin:0">
     <h1 id="marker">browser-region-probe-loaded</h1>
     <div style="height:4000px"></div>
     <script>window.__nonce = Math.random().toString(36).slice(2)</script>`,
    'utf8',
  )
  probeUrl = pathToFileURL(probePath).href

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 9,
      // `slug` is required: `isProject` drops a project row without one.
      // Two projects, because membership in this region is per project and
      // one project cannot show the difference between "no browser panes
      // anywhere" and "none in the project you are looking at".
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: null },
        { id: 'p2', name: 'other', slug: 'other', cwd: otherCwd, presets: [], activeTabId: null },
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

/**
 * Opens a browser pane the way a user does, through the palette command, and
 * returns the new pane's id.
 *
 * The id is read off the last `browsertab-` testid, exactly as
 * `browser.spec.ts`'s helper of the same shape reads it. The first test below
 * is the one measuring that the bar lists it at all, and it takes its own
 * counts rather than trusting this; the id is here because closing a pane and
 * addressing one both need it.
 */
async function openBrowserPaneViaPalette(page: Page): Promise<string> {
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.getByTestId('palette-input').fill('New browser pane')
  await page.getByTestId('palette-command-New browser pane').click()
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  const testId =
    (await page.locator('[data-testid^="browsertab-"]').last().getAttribute('data-testid')) ?? ''
  return testId.replace('browsertab-', '')
}

/**
 * What the one live browser-pane guest says about itself: its own `__nonce`
 * (minted by the probe page's script on every load, so a changed nonce is a
 * page that was rebuilt rather than kept), the viewport it is laid out in,
 * and where it is scrolled to.
 *
 * `webContents.getAllWebContents()` filtered by `getType() === 'webview'` is
 * the only mechanism that reaches inside a guest at all; see this file's
 * header and `browser.spec.ts`'s. `guests` is reported rather than asserted
 * on in here so a caller can tell "the pane was unmounted" (zero guests)
 * apart from "the page inside it changed".
 */
async function guestState(
  app: ElectronApplication,
): Promise<{ guests: number; nonce?: string; width?: number; scrollY?: number; url?: string }> {
  const raw = await app.evaluate(async ({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
    if (guests.length !== 1) return JSON.stringify({ guests: guests.length })
    return guests[0]!.executeJavaScript(
      'JSON.stringify({guests: 1, nonce: window.__nonce ?? null, width: innerWidth, scrollY: Math.round(scrollY), url: location.href})',
    )
  })
  return JSON.parse(raw)
}

test('a browser pane opens in its own region, not in the terminal bar', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // A real terminal tab first, so the count taken below is a number the
  // browser open could change, rather than a zero it could only leave alone.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible()
  const terminalTabsBefore = await page.locator('[data-testid^="tab-"]').count()
  expect(terminalTabsBefore).toBe(1)

  await openBrowserPaneViaPalette(page)

  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)
  // The assertion that proves the pane LEFT the terminal bar. The two above
  // pass just as well with the pane drawn in both places, and this one is
  // satisfied by the value the count already had, so it is taken after them
  // and never on its own.
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabsBefore)
  // The pane itself is inside the column, not merely a column that appeared.
  await expect(
    page.getByTestId('browser-column').locator('[data-testid^="browserpane-"]'),
  ).toHaveCount(1)

  await app.close()
})

test('the region appears on the first browser and goes away with the last', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // Neither state of the column: not the panel, and not the strip either. A
  // window that has never opened a browser has no browser chrome in the row.
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()

  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId(`close-${id}`).click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()

  await app.close()
})

test('collapsing the region leaves a strip, and the next browser opens the column again', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // `browser-toggle` is the heading while the column is open and the strip
  // while it is collapsed, one element at a time, the same testid every
  // column in this app gives both. So this click is the heading's, and what
  // it is worth asserting on afterwards is the PANEL's own state rather than
  // the thing that was clicked.
  await page.getByTestId('browser-toggle').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeVisible()
  // Collapsed is not closed: the pane is still mounted behind the strip.
  await expect(page.locator('[data-testid^="browserpane-"]')).toHaveCount(1)

  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(2)

  await app.close()
})

/**
 * The measurement behind the collapsed branch of `BrowserColumn`, run as a
 * test rather than written down as a claim.
 *
 * Taken 2026-08-11 against this exact sequence: a `<webview>` whose box is
 * shrunk to the strip's width reflows the page inside it (`innerWidth` 463
 * to 7), and one whose box is kept at the column's open width and hidden
 * with `visibility` fires no `resize` in the guest at all. Both leave the
 * page itself alone; unmounting the pane, which is what the collapsed branch
 * did before this test existed, does not.
 */
test('collapsing does not reload or reflow the page inside a browser pane', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  const id = await openBrowserPaneViaPalette(page)

  const bar = page.getByTestId(`browserurl-${id}`)
  await bar.fill(probeUrl)
  await bar.press('Enter')
  await expect
    .poll(async () => (await guestState(app)).url, { timeout: 15_000 })
    .toBe(probeUrl)

  // Scrolled, so a page that was rebuilt is visible as a lost scroll
  // position and not only as a fresh nonce.
  await app.evaluate(async ({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
    await guests[0]!.executeJavaScript('scrollTo(0, 1500)')
  })
  await expect.poll(async () => (await guestState(app)).scrollY, { timeout: 5_000 }).toBe(1500)
  const before = await guestState(app)

  await page.getByTestId('browser-toggle').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  // Read while the column is a strip: the guest is still there, still laid
  // out at the width it had, and still on the same page.
  const collapsed = await guestState(app)
  expect(collapsed.guests).toBe(1)
  expect(collapsed.nonce).toBe(before.nonce)
  expect(collapsed.width).toBe(before.width)
  expect(collapsed.scrollY).toBe(1500)

  await page.getByTestId('browser-toggle').click()
  await expect(page.getByTestId('browser-column')).toBeVisible()
  const after = await guestState(app)
  expect(after.nonce).toBe(before.nonce)
  expect(after.width).toBe(before.width)
  expect(after.scrollY).toBe(1500)

  await app.close()
})

test('the region belongs to the project whose browser panes it holds', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // The pane still exists, and belongs to `p1`. What the row shows is a
  // question about the ACTIVE project, so neither the column nor its strip
  // is on screen here.
  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()

  await page.getByTestId('project-p1').click()
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)

  await app.close()
})

test('a hide survives a trip through another project, and the next browser undoes it', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // ⌘⇧\, the hide-all binding, which is the only route a user has to hiding
  // this column: it has no View menu item and no shortcut of its own.
  await page.keyboard.press('Meta+Shift+Backslash')
  await expect(page.getByTestId('browser-column')).toBeHidden()

  // The round trip is the point. The count of the active project's browser
  // panes falls to zero on the way out and rises again on the way back, and
  // neither is an open or a close, so neither may touch what the user chose.
  await page.getByTestId('project-p2').click()
  await page.getByTestId('project-p1').click()
  // A real round trip through main, and several renders, before the two
  // assertions below. `toBeHidden` is satisfied by the very first frame it
  // looks at, and on the frame right after the click the column is legitimately
  // still absent whether the visibility rule is right or wrong: the effect that
  // would wrongly bring it back has not run yet. Measured by deleting the
  // project guard from that effect in `App.tsx`: without this wait the test
  // passed anyway, with it the test fails, which is the only reason it is here.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()

  // Opening one is what undoes it, which is the whole of "a manual hide
  // sticks until the next browser opens".
  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(2)

  await app.close()
})

test('a hide survives a relaunch, with the pane still there behind it', async () => {
  const first = await launch()
  const page = await first.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Meta+Shift+Backslash')
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await first.close()

  // The same `userDataDir`, so the same localStorage: the stored flag is the
  // only thing carrying the hide across, and the restored project has a
  // browser pane, so nothing else here would keep the column off screen.
  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  await expect(reopened.getByTestId('new-tab')).toBeVisible({ timeout: 20_000 })
  await expect(reopened.getByTestId('browser-column')).toBeHidden()

  // And the pane is still in the project, not lost with the column: the next
  // open puts the column back with both panes listed in its bar.
  await openBrowserPaneViaPalette(reopened)
  await expect(reopened.getByTestId('browser-column')).toBeVisible()
  await expect(reopened.locator('[data-testid^="browsertab-"]')).toHaveCount(2)
  await expect(reopened.getByTestId(`browsertab-${id}`)).toBeVisible()

  await second.close()
})
