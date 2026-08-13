/**
 * The dev server button in the terminal column's tab bar, end to end.
 *
 * Five tests, each launching its own app on the `pterm-e2e-devserver` socket:
 * the button is in the terminal bar and not in the browser column's bar, it
 * is disabled with no project at all, it is disabled on Unsorted, a press
 * with nothing announced opens a blank pane, and a press after a pane
 * announced a dev server URL opens a pane on that URL.
 *
 * **The project's id and its slug are deliberately different strings here.**
 * `window.pterm.devServerUrl` is asked by project SLUG and
 * `window.pterm.openBrowser` by project ID (see both doc comments in
 * `src/shared/ipc.ts`). `openBrowser` does convert one into the other, on
 * every press of this button: it finds the project row by id and stamps the
 * pane it writes with that row's slug. What no handler does is convert on the
 * LOOKUP side, so an id handed to `devServerUrl` is not resolved to a slug,
 * it simply misses. A handler that hands either call the other name looks right
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
 * (`grep -rn 'devServers\.observe(' src/`, one hit, in
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
 * resolve to `::1` first. That the host is spelled numerically changes nothing
 * about what the scanner does with it (`isLoopbackUrl` accepts both,
 * `src/shared/localOrigin.ts`).
 *
 * **The printf bolds the PORT, inside the URL, because that is the half of
 * Vite's line the scanner had to be built around.** An earlier version of this
 * file wrapped colour codes around the URL and left the port plain, and a
 * defect that made every real dev server undetectable passed it: tmux re-emits
 * an end-of-attribute as terminfo's `sgr0`, `\E(B\E[m` for `xterm-256color`,
 * so bolding the port puts a non-CSI `\x1b(B` between the port digits and the
 * trailing slash, and a strip that handles CSI alone leaves it there. Nothing
 * in this file writes that byte: the format string below asks for `\033[1m`
 * and `\033[22m` exactly as Vite does, and tmux substitutes the `sgr0` on the
 * way out. Measured through a `node-pty` tmux client: this printf comes back
 * as `\x1b[36mhttp://127.0.0.1:\x1b[1m51234\x1b(B\x1b[m\x1b[36m/\x1b[39m`,
 * the same shape as a captured real Vite banner (see the fixture header in
 * `tests/unit/devServerScan.test.ts`).
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

/**
 * The one project row every test starts with. `cwd` is filled in per test,
 * since it is a fresh temp directory each time.
 */
const PROJECT_ROW = (): Record<string, unknown> => ({
  id: PROJECT_ID,
  name: 'demo',
  slug: PROJECT_SLUG,
  cwd: projectCwd,
  presets: [],
  activeTabId: null,
})

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
/** The port `devUrl` names, announced separately so the printf can bold it. */
let devPort: number

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
function startServer(): Promise<{ server: Server; url: string; port: number }> {
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
      resolve({
        server: created,
        url: `http://127.0.0.1:${address.port}/`,
        port: address.port,
      })
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
/** Overwrite the seeded config, for a test that needs a different workspace. */
async function writeConfig(config: unknown): Promise<void> {
  await writeFile(join(configDir, 'config.json'), JSON.stringify(config), 'utf8')
}

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

  await writeConfig({
    version: 9,
    projects: [PROJECT_ROW()],
    panes: [],
    tabs: [],
    activeProjectId: PROJECT_ID,
  })

  const started = await startServer()
  server = started.server
  devUrl = started.url
  devPort = started.port
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
  // to be absent from: with no browser pane anywhere in the workspace, which
  // is what `App.tsx` gates that column on, it renders nothing at all and the
  // check would pass without a bar existing.
  await pressBrowserButton(page)
  await expect(page.getByTestId('browsertabbar')).toHaveCount(1)

  await expect(page.getByTestId('browsertabbar').getByTestId('open-devserver')).toHaveCount(0)
  // The same fact counted from the whole window, so a button rendered in some
  // third place would fail here even if it were outside the browser bar.
  await expect(page.getByTestId('open-devserver')).toHaveCount(1)

  await app.close()
})

/**
 * The two states the button is disabled in, both of them a project main cannot
 * open a pane for, and both reachable with the bar on screen: `showsTabBar`
 * reads column visibility and nothing else, so the bar is there on the welcome
 * page too.
 *
 * They are separate tests because they disable it through separate halves of
 * one predicate, and a single test would pass on either.
 */
test('the button is disabled with no project to open a pane for', async () => {
  await writeConfig({ version: 9, projects: [], panes: [], tabs: [], activeProjectId: null })
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // Present but dead, rather than gone: the `+` beside it behaves the same
  // way here, since `canOpenSession` is false with no project.
  await expect(page.getByTestId('open-devserver')).toBeDisabled()

  await app.close()
})

test('the button is disabled on Unsorted, which config has no project row for', async () => {
  // A browser pane whose slug names no project is what puts Unsorted on
  // screen (`withUnsorted`, `src/main/ipc/restore.ts`), and being sessionless
  // it needs no pty to exist. The real project is left in the config on
  // purpose: if `activeProjectId` did not stick, the app would fall back to it
  // and the button would be enabled, so this test fails rather than passing
  // for the wrong reason.
  await writeConfig({
    version: 9,
    projects: [PROJECT_ROW()],
    panes: [
      {
        id: 'straypane',
        projectSlug: 'no_such_project',
        cwd: projectCwd,
        type: 'browser',
        url: 'about:blank',
      },
    ],
    tabs: [
      {
        id: 'straypane',
        groupId: 'straypane',
        activePaneId: 'straypane',
        layout: { dir: 'row', ratio: [1], kids: ['straypane'] },
      },
    ],
    activeProjectId: 'unsorted',
  })
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // The premise, pinned: Unsorted really is the active project, so the
  // assertion below is about that half of the predicate and not about a
  // project having gone missing.
  await expect(page.getByTestId('project-unsorted')).toHaveAttribute('data-active', 'true')

  await expect(page.getByTestId('open-devserver')).toBeDisabled()

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

  // Vite's shape, port included: colour around the line, bold around the port
  // and nothing else, which is what makes tmux plant an `\x1b(B` between the
  // digits and the slash. The shell emits real escape bytes because they are
  // in printf's format string.
  //
  // Host and port are ARGUMENTS, so the only place either number is written
  // is `devUrl`'s own server. The scheme stays in the format string on
  // purpose, so that the line zsh echoes as it is typed holds no URL the
  // scanner can accept: `http://%s...` does not parse (`new URL` throws on
  // the `%s` host), whereas typing the origin as an argument left a bare
  // `http://127.0.0.1:` in the echo, which parses as loopback and was filed
  // as the answer when the real announcement went undetected. The scanner
  // refuses a portless origin now (`announcesLoopbackPort`, `devserver/
  // scan.ts`), so that echo would no longer be filed; the scheme stays in the
  // format string anyway, because it makes printf's output the only URL in
  // the whole stream a scanner could accept at all, and the assertion below
  // should not rest on a second rule holding.
  await page.keyboard.type(
    `printf '  \\033[32m->\\033[39m  \\033[1mLocal\\033[22m:   \\033[36mhttp://%s\\033[1m%s\\033[22m/\\033[39m\\n' '127.0.0.1:' ${devPort}`,
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
