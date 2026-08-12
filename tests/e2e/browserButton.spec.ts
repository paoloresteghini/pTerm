/**
 * The dev server button in the terminal column's tab bar, end to end.
 *
 * Three tests, each launching its own app on the `pterm-e2e-devserver` socket:
 * the button is in the terminal bar and not in the browser column's bar, a
 * press with nothing announced opens a blank pane, and a press after a pane
 * announced a dev server URL opens a pane on that URL.
 *
 * **The project's id and its slug are deliberately different strings here.**
 * `window.pterm.devServerUrl` is asked by project SLUG and
 * `window.pterm.openBrowser` by project ID (see both doc comments in
 * `src/shared/ipc.ts`), and nothing in main converts one into the other for
 * this feature. A handler that hands either call the other name looks right
 * and fails quietly: asking for a URL by id answers null, which is
 * indistinguishable from "no server has announced itself", so the button still
 * opens a pane and only the URL is wrong. A fixture whose project id equalled
 * its slug would pass with the two swapped, which is why `PROJECT_ID` and
 * `PROJECT_SLUG` below are unequal and why the last test asserts on the URL
 * the pane actually loaded rather than on a pane appearing.
 *
 * **The announcement is driven through a real pty**, by typing a `printf` into
 * a terminal pane and running it. Pty output is what files a URL: main's
 * registry is written from one `manager.onData` forward and from nowhere else
 * (`grep -rn '\.observe(' src/`, one hit outside the registry itself,
 * `src/main/ipc/register.ts`). The shell produces the escape bytes from the
 * format string rather than the test typing an ESC byte, which a terminal
 * would echo back as a visible `^[` instead of acting on.
 *
 * **A press is asserted through main, not through the guest document.**
 * Playwright cannot enter a `<webview>` on this codebase: `frames()` reports
 * `about:blank` and `frameLocator` throws. `guestUrl` and `guestText` below
 * are `browser.spec.ts`'s mechanism, `webContents.getAllWebContents()`
 * filtered to the one guest.
 *
 * The announced URL is on `127.0.0.1` rather than the `localhost` a real Vite
 * banner prints, for the reason `browser.spec.ts` serves from that address
 * too: the throwaway server below binds one address, and `localhost` can
 * resolve to `::1` first. The ANSI wrapping around the URL is Vite's shape,
 * which is the half of the line this feature had to be built around; that the
 * host is spelled numerically changes nothing about what the scanner does with
 * it (`isLoopbackUrl` accepts both, `src/shared/localOrigin.ts`).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, capturePane } from './harness'

const SOCKET = 'pterm-e2e-devserver'

/**
 * The project's two names, unequal on purpose. See the header: this fixture is
 * what makes a swap of the two calls' arguments observable.
 *
 * The slug is `[a-z0-9_]+` and nothing else. `encodeSessionName`
 * (`src/main/tmux/names.ts`) puts it in a tmux session name and throws on
 * anything outside that set, which a first draft of this file learned by
 * spelling the slug `demo-slug` and getting no terminal pane at all. The id
 * has no such rule, so the two are told apart by its dashes.
 */
const PROJECT_ID = 'proj-id-9f'
const PROJECT_SLUG = 'demo_web'

/** The prompt every pane in this file draws, so a test can wait for READY. */
const PANE_PROMPT = 'pTermE2E$'
const PANE_RC = `PS1='${PANE_PROMPT} '\nHISTSIZE=0\n`

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let zdotdir: string
let server: Server
let devUrl: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
    zdotdir,
  })

/**
 * A throwaway HTTP server on an OS-assigned port, serving one marked page.
 *
 * A real server rather than a made-up port: the last test asserts the pane
 * both aimed at the announced URL and loaded it, and a dead port would leave
 * the browser's own error page behind while `getURL()` still reported the URL.
 */
function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const created = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><title>dev server</title><h1 id="marker">dev-server-page</h1>')
    })
    created.once('error', reject)
    created.listen(0, '127.0.0.1', () => {
      const address = created.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('startServer: no port assigned'))
        return
      }
      resolve({ server: created, url: `http://127.0.0.1:${address.port}/` })
    })
  })
}

/** The URL of the one live browser-pane guest, or null if there is not exactly one. */
async function guestUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => {
    const guests = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
    return guests.length === 1 ? guests[0]!.getURL() : null
  })
}

/** `selector`'s `textContent` inside the one live guest, or null. Pollable. */
async function guestText(app: ElectronApplication, selector: string): Promise<string | null> {
  return app.evaluate(async ({ webContents }, sel) => {
    const guests = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
    if (guests.length !== 1) return null
    return guests[0]!.executeJavaScript(`document.querySelector('${sel}')?.textContent ?? null`)
  }, selector)
}

/**
 * Presses the button and returns the pane id of the browser pane it opened,
 * read off the last `browsertab-` row (this file opens at most one browser
 * pane per test, so the last row is unambiguous).
 */
async function pressBrowserButton(page: Page): Promise<string> {
  await page.getByTestId('open-devserver').click()
  const testId =
    (await page.locator('[data-testid^="browsertab-"]').last().getAttribute('data-testid')) ?? ''
  const id = testId.replace('browsertab-', '')
  await expect(page.getByTestId(`browserpane-${id}`)).toBeVisible({ timeout: 20_000 })
  return id
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-devbtn-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-devbtn-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-devbtn-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-devbtn-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-devbtn-claude-'))
  zdotdir = await mkdtemp(join(tmpdir(), 'pterm-devbtn-zdotdir-'))
  await writeFile(join(zdotdir, '.zshrc'), PANE_RC, 'utf8')

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 9,
      projects: [
        {
          id: PROJECT_ID,
          name: 'demo',
          slug: PROJECT_SLUG,
          cwd: projectCwd,
          presets: [],
          activeTabId: null,
        },
      ],
      panes: [],
      tabs: [],
      activeProjectId: PROJECT_ID,
    }),
    'utf8',
  )

  const started = await startServer()
  server = started.server
  devUrl = started.url
})

test.afterEach(async () => {
  await killServer(SOCKET)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome, zdotdir]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the terminal tab bar offers the browser button and the browser column does not', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  await expect(page.getByTestId('tabbar').getByTestId('open-devserver')).toHaveCount(1)

  // Opens the browser column, which is what gives the absence below something
  // to be absent from: with no browser pane in the active project, that column
  // renders nothing at all and the check would pass without a bar existing.
  await pressBrowserButton(page)
  await expect(page.getByTestId('browsertabbar')).toHaveCount(1)

  await expect(page.getByTestId('browsertabbar').getByTestId('open-devserver')).toHaveCount(0)
  // The same fact counted from the whole window, so a button rendered in some
  // third place would fail here even if it were outside the browser bar.
  await expect(page.getByTestId('open-devserver')).toHaveCount(1)

  await app.close()
})

test('pressing it with no dev server announced opens a blank browser pane', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  const id = await pressBrowserButton(page)

  await expect(page.getByTestId(`browserurl-${id}`)).toHaveValue('about:blank')
  await expect.poll(() => guestUrl(app), { timeout: 10_000 }).toBe('about:blank')

  await app.close()
})

test('pressing it after a pane announced a URL opens a pane on that URL', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // A real pane with a real shell, waited on by the prompt this file's own rc
  // draws: a command typed into the gap between the session existing and zsh
  // being ready arrives mangled.
  await page.getByTestId('new-tab').click()
  // 20s rather than the 5s default: this is the first pane on a fresh socket,
  // so the click waits on a tmux server starting as well as on a render, and
  // 5s was measured to time out here on a busy machine.
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const session = (await sessionNames(SOCKET))[0]!
  await expect
    .poll(() => capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain(PANE_PROMPT)

  // Vite's shape: the URL wrapped in colour codes, which the shell emits as
  // real escape bytes because they are in printf's format string. The URL is
  // the ARGUMENT rather than part of the format, so the copy zsh echoes back
  // as it is typed is the same string as the copy printf writes, and the two
  // cannot disagree about which URL was announced.
  await page.keyboard.type(
    `printf '  \\033[32m->\\033[39m  \\033[1mLocal\\033[22m:   \\033[36m%s\\033[39m\\n' ${devUrl}`,
  )
  await page.keyboard.press('Enter')

  // The announcement landed, asserted before anything is pressed: a test that
  // went straight to the button would report a filing failure as a button
  // failure. Asked by slug, which is the name main's registry keys on.
  await expect
    .poll(() => page.evaluate((slug) => window.pterm.devServerUrl(slug), PROJECT_SLUG), {
      timeout: 20_000,
    })
    .toBe(devUrl)
  // And the id is NOT a key for it. This is the swap, one layer down from the
  // button: if this ever answers the URL, `devServerUrl(project.id)` in the
  // renderer would work by accident and the test below would stop meaning
  // anything.
  expect(await page.evaluate((id) => window.pterm.devServerUrl(id), PROJECT_ID)).toBeNull()

  const id = await pressBrowserButton(page)

  await expect(page.getByTestId(`browserurl-${id}`)).toHaveValue(devUrl)
  await expect.poll(() => guestUrl(app), { timeout: 15_000 }).toBe(devUrl)
  // The pane reached the page, rather than only aiming at it.
  await expect.poll(() => guestText(app, '#marker'), { timeout: 15_000 }).toBe('dev-server-page')

  await app.close()
})
