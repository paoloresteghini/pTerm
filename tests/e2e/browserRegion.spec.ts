/**
 * The browser region on screen: a column of its own, with a bar of its own.
 *
 * Set up like `tests/e2e/browser.spec.ts`, which this borrows its palette
 * route from: one app per test, its own tmux socket, and a fresh user data
 * directory so no stored column width or collapse flag leaks in from another
 * run.
 *
 * Most of what is asserted here is host-side chrome. Where a test has to tell
 * a page that SURVIVED from one that was rebuilt at the same URL, it reads the
 * guest through `guestState` below, which goes main-side through
 * `webContents.executeJavaScript`. That is the only mechanism that reaches
 * inside a `<webview>` at all: Playwright cannot, `page.frames()` reports the
 * guest as `about:blank` and `frameLocator` throws outright (see
 * `browser.spec.ts`'s header for that measurement).
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
  // GONE, not put away, which is the distinction `toBeHidden` alone cannot
  // draw: it is satisfied by an element that is merely not painted. Closing
  // the last browser pane in the workspace is the one case that really does
  // unmount, because there is nothing left to keep alive.
  await expect(page.getByTestId(`browserpane-${id}`)).toHaveCount(0)

  await app.close()
})

test('collapsing the region leaves a strip, and the next browser opens the column again', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  const id = await openBrowserPaneViaPalette(page)
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
  // And mounted is not the same as drawn. Worth its own assertion because
  // `visibility` INHERITS but can be overridden: the active group carried a
  // `visible` class for a while, which re-showed the pane straight through
  // the box that was hiding it, with nothing counting elements able to tell.
  await expect(page.getByTestId(`browserpane-${id}`)).toBeHidden()

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

  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // The pane still exists, and belongs to `p1`. What the row shows is a
  // question about the ACTIVE project, so neither the column nor its strip
  // is on screen here.
  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()
  // Put away, not gone, which takes both assertions: `toBeHidden` alone is
  // satisfied by an element that is not there, and a count alone says
  // nothing about paint. Together they are the host-side statement of
  // "mounted and not drawn".
  await expect(page.getByTestId(`browserpane-${id}`)).toHaveCount(1)
  await expect(page.getByTestId(`browserpane-${id}`)).toBeHidden()

  await page.getByTestId('project-p1').click()
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)

  await app.close()
})

/**
 * The other half of `the region belongs to the project whose browser panes it
 * holds`: the column goes away, and the page inside it does not.
 *
 * This is the test that fails if the column ever goes back to unmounting. It
 * asserts on the guest itself rather than on the column reappearing, because a
 * column that reappears having rebuilt its `<webview>` looks identical from the
 * host side. The evidence is `__nonce`, minted by the probe page's own script
 * on every load: a rebuilt pane loads the URL its pane RECORD carries and mints
 * a new one, and, since navigation is reported to main rather than written back
 * into renderer state, it would not even be this URL. Same nonce and same URL
 * is a page that was never rebuilt.
 */
test('a page in a browser pane survives a trip through a project that has none', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  const id = await openBrowserPaneViaPalette(page)

  const bar = page.getByTestId(`browserurl-${id}`)
  await bar.fill(probeUrl)
  await bar.press('Enter')
  await expect.poll(async () => (await guestState(app)).url, { timeout: 15_000 }).toBe(probeUrl)
  await app.evaluate(async ({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
    await guests[0]!.executeJavaScript('scrollTo(0, 1500)')
  })
  await expect.poll(async () => (await guestState(app)).scrollY, { timeout: 5_000 }).toBe(1500)
  const before = await guestState(app)

  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  // Read while the column is nowhere on screen. One guest, still there: an
  // unmounting column would report zero here, before any of the rest could
  // even be asked.
  const away = await guestState(app)
  expect(away.guests).toBe(1)
  expect(away.nonce).toBe(before.nonce)
  expect(away.width).toBe(before.width)

  await page.getByTestId('project-p1').click()
  await expect(page.getByTestId('browser-column')).toBeVisible()
  const back = await guestState(app)
  expect(back.nonce).toBe(before.nonce)
  expect(back.url).toBe(probeUrl)
  expect(back.scrollY).toBe(1500)
  expect(back.width).toBe(before.width)

  await app.close()
})

/**
 * The stored visibility flag is global, so nothing may write it from a
 * question about one project.
 *
 * The sequence is the reviewer's, verbatim. Before the auto-hide condition was
 * made global, the close in `p2` took the count for THAT project from one to
 * zero and hid the column for the whole window, so coming back to `p1`, which
 * still had a browser pane and whose user had hidden nothing, found the column
 * gone with no menu item or shortcut to bring it back.
 */
test('closing the last browser in one project does not hide another project s column', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  const first = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  const second = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await page.getByTestId(`close-${second}`).click()
  // p2 is back to having none of its own, so the column is off screen here.
  // That is the draw gate, and it must not have written anything down.
  await expect(page.getByTestId('browser-column')).toBeHidden()

  await page.getByTestId('project-p1').click()
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.getByTestId('browser-toggle')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)
  await expect(page.getByTestId(`browserpane-${first}`)).toBeVisible()

  await app.close()
})

test('a column that is nowhere on screen costs the row no width', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // `terminal-column` is the row's one `flex-1 min-w-0` item, so it absorbs
  // whatever every other column does not take. Measured before any browser
  // pane exists, which is the only state in which the column is not in the
  // tree at all, and is therefore the baseline "costs nothing" has to match.
  const empty = await page.getByTestId('terminal-column').boundingBox()
  expect(empty).not.toBeNull()

  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })
  const open = await page.getByTestId('terminal-column').boundingBox()
  // The column really is taking width while it is open, so the comparison
  // below is between two different things rather than two of the same.
  expect(open!.width).toBeLessThan(empty!.width)

  // Collapsed next, which is the state the hidden pane box shares its
  // positioning with. What the row loses must be the strip and nothing else:
  // the box holding the panes is `absolute`, so it contributes no width even
  // though it is 480 wide. Without that, this column would take its widest
  // child's width and the strip would cost twenty times what it should.
  // Compared against the strip's own measured box rather than against `w-6`
  // written out as 24: the two disagree by a pixel on this window, and which
  // one is right is not what this test is about.
  await page.getByTestId('browser-toggle').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  const strip = await page.getByTestId('browser-toggle').boundingBox()
  const collapsed = await page.getByTestId('terminal-column').boundingBox()
  expect(strip!.width).toBeLessThan(40)
  expect(collapsed!.width).toBe(empty!.width - strip!.width)
  // Full height, like every other column's strip. Both are items of the same
  // row and both stretch, so the terminal's height is what this one has to
  // match. Measured when this was missed: a 45px button with 668px of bare
  // canvas under it, because the strip had become a `flex-col` child, where
  // height is the main axis and comes from the content.
  expect(strip!.height).toBe(collapsed!.height)

  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  const away = await page.getByTestId('terminal-column').boundingBox()
  expect(away!.width).toBe(empty!.width)

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

/**
 * Hide-all, end to end, with a browser column in the row.
 *
 * The item's label is read off the real menu through main, the way
 * `menuColumns.spec.ts` reads it: Playwright cannot reach the macOS menu bar,
 * and the label is computed in `showColumns` from what the renderer sends over
 * `columnsVisible`, so reading it is the only way to see whether the two agree.
 */
test('hide all takes the browser column with it, keeps the page, and puts it back', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  const labelOf = (): Promise<string | undefined> =>
    app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('hide-all-columns')?.label)
  // The item itself, not its ⌘⇧\ shortcut. This test types a URL into a
  // browser pane's address bar first, and that field carries
  // `data-shortcuts="off"`, so the keystroke would never reach `App`'s
  // handler: measured, the column was still on screen after pressing it.
  const clickHideAll = (): Promise<void> =>
    app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('hide-all-columns')?.click()
    })

  // Nothing is open on a fresh profile, and the browser column is not in the
  // row either, so the item offers the only direction that would do anything.
  await expect.poll(labelOf, { timeout: 10_000 }).toBe('Show All Columns')

  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })
  const bar = page.getByTestId(`browserurl-${id}`)
  await bar.fill(probeUrl)
  await bar.press('Enter')
  await expect.poll(async () => (await guestState(app)).url, { timeout: 15_000 }).toBe(probeUrl)
  const before = await guestState(app)

  // One column on screen, and it is this one: the item has to offer to hide.
  await expect.poll(labelOf, { timeout: 10_000 }).toBe('Hide All Columns')

  await clickHideAll()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()
  // Mounted and not drawn, the same pair the project-switch test takes.
  await expect(page.getByTestId(`browserpane-${id}`)).toHaveCount(1)
  await expect(page.getByTestId(`browserpane-${id}`)).toBeHidden()
  await expect.poll(labelOf, { timeout: 10_000 }).toBe('Show All Columns')
  // Hidden by the same route as a project switch, and it keeps the page for
  // the same reason.
  const hiddenState = await guestState(app)
  expect(hiddenState.guests).toBe(1)
  expect(hiddenState.nonce).toBe(before.nonce)

  // The second press restores exactly what the first put away, this column
  // included, which is what makes it a member of `COLUMN_IDS` rather than an
  // exception to it.
  await clickHideAll()
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect.poll(labelOf, { timeout: 10_000 }).toBe('Hide All Columns')
  const restored = await guestState(app)
  expect(restored.nonce).toBe(before.nonce)
  expect(restored.url).toBe(probeUrl)

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

/**
 * Clicks the page INSIDE the browser column's live `<webview>`.
 *
 * The centre of `browser-column` lands in the pane area, so this is a click on
 * guest content and not on the column's own chrome. What the host sees for it
 * was measured 2026-08-11 and is the reason `App` does not listen for
 * `focusin` alone: the host document gets NO `focusin`, no `mousedown` and no
 * `click`, only a `focusout` on whatever it had focused and a `window` blur,
 * after which `document.activeElement` is the `<webview>` element. See the
 * `activeRegion` effect in `App.tsx` for the handler that reads that.
 *
 * NOTHING MAY PRESS A KEY WHILE THIS IS THE LAST THING THAT HAPPENED. Once the
 * guest holds focus the host window is blurred, and a key press then reaches
 * the guest rather than `App`'s window `keydown` listener. Measured 2026-08-12:
 * of six runs of this file's tab-select test written that way, one passed. The
 * failures were not a misrouted keystroke but no keystroke at all, with both
 * bars' `data-active` unchanged. Use `focusBrowserRegion` below for a test that
 * needs to press something.
 */
async function clickGuestPage(page: Page): Promise<void> {
  await page.getByTestId('browser-column').click()
}

/**
 * States, host-side, that the browser region is the one the user is working
 * in: a click on one of its own tab rows rather than on guest content.
 *
 * Callers reach here having already opened a pane through the palette, which
 * claims the region on its own, so this is a re-assertion and not the only
 * thing standing between the test and its keystroke. It is here because the
 * obvious way to write that line, a click on the guest page, cannot be
 * followed by a key press at all (see `clickGuestPage`), and because a test
 * whose setup depends on the palette's claim alone would not say so.
 *
 * Takes the row's index because it also SELECTS that row, which callers have
 * to account for.
 */
async function focusBrowserRegion(page: Page, index: number): Promise<void> {
  await page.locator('[data-testid^="browsertab-"]').nth(index).click()
}

/** Clicks the visible terminal pane, away from its edges. */
async function clickTerminal(page: Page): Promise<void> {
  await page.getByTestId('terminal-active').click({ position: { x: 40, y: 60 } })
}

test('Cmd-W closes a pane in the region that has focus, and leaves the other alone', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // TWO of each. One apiece would make each "the other region did not change"
  // assertion a statement about a count that had nowhere to go: with a single
  // terminal tab, a ⌘W that wrongly closed it would be caught, but with none
  // at all the same assertion holds however wrong the routing is.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible()
  await page.getByTestId('new-tab').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await openBrowserPaneViaPalette(page)
  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(2)

  // Both counts read BEFORE the keystroke. A count taken afterwards is the
  // number the keystroke produced, and comparing it to itself proves nothing.
  const terminalTabs = await page.locator('[data-testid^="tab-"]').count()
  const browserTabs = await page.locator('[data-testid^="browsertab-"]').count()
  expect(terminalTabs).toBe(2)
  expect(browserTabs).toBe(2)

  // Row 1, which is already the selected one, so this changes the REGION and
  // nothing else. It has to be a host-side click: see `clickGuestPage`'s note
  // for why a key pressed straight after a guest click may never arrive.
  await focusBrowserRegion(page, 1)
  await page.keyboard.press('Meta+w')

  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(browserTabs - 1)
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabs)

  // And back, which is the half that would go unnoticed: a ⌘W that always
  // closed a browser pane once the region had been claimed would satisfy the
  // two assertions above. The click lands on the terminal pane that is
  // ALREADY active, so `selectPane` claims the region and then returns
  // without dispatching anything, and the `pointerdown` rule claims it too.
  // Either one is enough; what is asserted is that the region moved, not
  // which of them moved it.
  await clickTerminal(page)
  await page.keyboard.press('Meta+w')

  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabs - 1)
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(browserTabs - 1)

  await app.close()
})

test('the tab-select chord selects within the region that has focus', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible()
  await page.getByTestId('new-tab').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await openBrowserPaneViaPalette(page)
  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // `data-active` is what `TabBar` already marks its active row with, for both
  // bars: see its `active` const. Nothing new is added here to read it.
  const terminal = page.locator('[data-testid^="tab-"]')
  const browser = page.locator('[data-testid^="browsertab-"]')

  // Opening selects, so the SECOND of each is active. That is what makes both
  // halves below able to fail: ⌥⌘1 asks for the first row either way, so a
  // keystroke that reached the wrong bar would be visible in it.
  await expect(terminal.nth(1)).toHaveAttribute('data-active', 'true')
  await expect(browser.nth(1)).toHaveAttribute('data-active', 'true')

  // Row 1, the one already selected, so ⌥⌘1 below still has somewhere to move
  // it to. Host-side for the reason `clickGuestPage` records.
  await focusBrowserRegion(page, 1)
  await page.keyboard.press('Alt+Meta+1')

  await expect(browser.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(browser.nth(1)).toHaveAttribute('data-active', 'false')
  await expect(terminal.nth(1)).toHaveAttribute('data-active', 'true')
  await expect(terminal.nth(0)).toHaveAttribute('data-active', 'false')

  // Put the browser's selection back on its second row, so the terminal half
  // below is asking ⌥⌘1 to move a selection that is somewhere else. Without
  // this the browser would already be on row one and "the browser did not
  // move" would be satisfied by a ⌥⌘1 that moved it there.
  await browser.nth(1).click()
  await expect(browser.nth(1)).toHaveAttribute('data-active', 'true')

  await clickTerminal(page)
  await page.keyboard.press('Alt+Meta+1')

  await expect(terminal.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(terminal.nth(1)).toHaveAttribute('data-active', 'false')
  await expect(browser.nth(1)).toHaveAttribute('data-active', 'true')
  await expect(browser.nth(0)).toHaveAttribute('data-active', 'false')

  await app.close()
})

test('clicking terminal chrome that focuses nothing still takes the keys back', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // Two terminal tabs, so "the right one closed" is a count with somewhere to
  // go rather than a drop to zero.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('new-tab').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // The browser region takes the keys, in the one way that reaches the host
  // through no host event at all.
  await clickGuestPage(page)

  // The title bar, chosen over the other chrome that focuses nothing because
  // it is the case with no second mechanism to rescue it. Measured 2026-08-12,
  // clicking it after a guest click fires NO `focusin` and NO `blur` and
  // leaves `document.activeElement` at `BODY`; the only thing the host sees is
  // `pointerdown DIV[titlebar]`, so the drag region does not swallow it. A
  // project row reaches the same stale state, but a switch to a project
  // holding a terminal pane focuses that pane and the `focusin` rule covers it,
  // which would make this test pass for a reason that is not the one under
  // test.
  await page.getByTestId('titlebar').click({ position: { x: 300, y: 8 } })

  const terminalTabs = await page.locator('[data-testid^="tab-"]').count()
  const browserTabs = await page.locator('[data-testid^="browsertab-"]').count()
  expect(terminalTabs).toBe(2)
  expect(browserTabs).toBe(1)

  await page.keyboard.press('Meta+w')

  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabs - 1)
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(browserTabs)

  await app.close()
})

test('picking a browser pane from the palette gives it the keys', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('new-tab').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(2)
  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // Hand the keys to the TERMINAL first, so the palette has to take them back
  // rather than finding them already where this test wants them. Without this
  // the open above would have left the region on 'browser' and the assertions
  // below would hold whether the palette claimed anything or not.
  await clickTerminal(page)

  // `paletteSessions` maps every pane, so the browser pane is listed here
  // beside the terminals. The route is entirely keyboard and the dialog is
  // portaled outside the browser column, so neither region rule can see which
  // region the chosen pane belongs to: only the pane itself says.
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.getByTestId(`palette-session-${id}`).click()
  await expect(page.getByTestId('command-palette')).toHaveCount(0)

  const terminalTabs = await page.locator('[data-testid^="tab-"]').count()
  const browserTabs = await page.locator('[data-testid^="browsertab-"]').count()
  expect(terminalTabs).toBe(2)
  expect(browserTabs).toBe(1)

  await page.keyboard.press('Meta+w')

  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(browserTabs - 1)
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabs)

  await app.close()
})

test('a browser region that leaves the screen hands the keys back to the terminal', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible()
  await page.getByTestId('new-tab').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(2)
  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // The browser region has the keys, and nothing that follows is a focus
  // event: hiding a column moves no focus, which is exactly why `keyRegion`
  // is derived from what is on screen rather than left as whatever focus
  // last said.
  //
  // Host-side, and this test used to click the guest page here instead. That
  // put two keystrokes behind the delivery race `clickGuestPage` warns about:
  // measured 8 passes in 8 that way, but the first run of a sabotage that
  // could not affect focus at all still failed on the ⇧⌘\ below never
  // arriving. A test does not get to keep a pattern its own helper documents
  // as unreliable on the grounds that it has not bitten yet.
  await focusBrowserRegion(page, 0)
  await page.keyboard.press('Meta+Shift+Backslash')
  await expect(page.getByTestId('browser-column')).toBeHidden()
  // Put away, not unmounted. That is what makes the assertions below able to
  // fail: there is still a browser pane for ⌘W to close if the derivation is
  // missing, and a stale `activeRegion` would name it.
  await expect(page.getByTestId(`browserpane-${id}`)).toHaveCount(1)

  const terminalTabs = await page.locator('[data-testid^="tab-"]').count()
  expect(terminalTabs).toBe(2)

  await page.keyboard.press('Meta+w')

  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabs - 1)
  await expect(page.getByTestId(`browserpane-${id}`)).toHaveCount(1)

  // And the region comes back with its pane still listed, so nothing above
  // closed it behind the hide.
  await page.keyboard.press('Meta+Shift+Backslash')
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)

  await app.close()
})

test('Cmd-D does nothing while the browser region has focus, and still splits the terminal', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible()
  const id = await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })

  // `:scope >`, as every pane count in `splits.spec.ts` takes it: `PaneDivider`
  // renders `data-testid="pane-divider"`, which a bare `[data-testid^="pane-"]`
  // inside the group also matches. Measured 2026-08-11: one split reads as
  // three elements without the child combinator, two with it.
  const terminalPanes = page
    .getByTestId('terminal-active')
    .locator(':scope > [data-testid^="pane-"]')
  await expect(terminalPanes).toHaveCount(1)

  await focusBrowserRegion(page, 0)
  await page.keyboard.press('Meta+d')
  await page.keyboard.press('Meta+Shift+d')

  // The browser region gained nothing, which is a count these two keystrokes
  // could have changed: ⌘D is the binding under test here, and a split is the
  // only thing it can add. (⌘T also adds a pane, but nothing below presses it.)
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)
  await expect(page.getByTestId(`browserpane-${id}`)).toHaveCount(1)

  // The control, and the reason the assertions around it can fail: the same
  // keystroke against the same window still splits, once the terminal is the
  // region with focus.
  await clickTerminal(page)
  await page.keyboard.press('Meta+d')
  await expect(terminalPanes).toHaveCount(2)

  // Read again after a settle, because the assertion above stops the moment
  // the control's own split lands and a leaked one arriving a beat later would
  // never be seen. 2.5s is the window a split was measured to complete in on
  // 2026-08-11 (three ⌘D presses held that long against a focused browser
  // region left the count at one, and one press against a focused terminal was
  // on screen well inside it). Exactly two: the control's split and no other.
  await page.waitForTimeout(2500)
  await expect(terminalPanes).toHaveCount(2)

  await app.close()
})
