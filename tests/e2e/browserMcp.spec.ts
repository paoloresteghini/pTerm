/**
 * A browser pane an agent owns, held to loopback origins.
 *
 * This is the enforcement point of the browser MCP plan
 * (`docs/superpowers/plans/2026-08-12-browser-mcp-foundation.md`, Task 7):
 * the decision taken in brainstorming was full control of the agent's own
 * pane, confined to loopback, which is only worth anything if the confinement
 * sits on the pane rather than on a tool's arguments.
 *
 * Every test here drives a navigation with NO tool argument in it: a link
 * clicked inside the page, and a redirect served by a page that was itself
 * loopback. Neither has a `url` parameter for a tool to check, which is the
 * argument the whole task rests on.
 *
 * The pane is seeded into `config.json` rather than opened through the
 * palette, and ownership arrives through `PTERM_AGENT_BROWSER_PANE`
 * (`harness.ts`'s `agentBrowserPane`, and the env var's own comment in
 * `src/main/ipc/register.ts`). Ownership has no other route into a running
 * app yet: the MCP tool call that claims a pane is Task 8. When it lands,
 * these tests should claim through it and the env var can go.
 *
 * Reading the guest goes main-side through
 * `webContents.getAllWebContents()`, the same mechanism and for the same
 * measured reason as `browser.spec.ts`: Playwright cannot enter a
 * `<webview>`, `page.frames()` reports the guest as `about:blank` and
 * `frameLocator` throws.
 *
 * A refusal is reported on the main process's stderr, and the tests poll for
 * that line rather than waiting a fixed time for nothing to happen: "the
 * pane did not move" is otherwise a claim that is true before the click as
 * well as after it.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-browsermcp'

/** The pane every test here seeds, and the session that owns it. */
const PANE = 'b1'
const OWNER = 'claude-1'

/**
 * The origin a confined pane must not reach. Never actually loaded by the
 * confined tests: the point is that the navigation is refused before a
 * request is made, so no test here depends on the network.
 */
const AWAY = 'https://example.com/'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let server: Server | null = null
let baseUrl: string
/**
 * The app `launch` last started, closed by `afterEach` whether or not the test
 * got as far as closing it itself.
 *
 * A test that fails mid-way never reaches its own `app.close()`, and the
 * teardown below then deletes the user data directory out from under a live
 * Electron process: measured while sabotaging this file's own enforcement,
 * that left one app per failed test still running, plus an `ENOTEMPTY` from
 * the partition directory being written during the delete, and it made a
 * later test in the same run time out on nothing but contention.
 */
let running: ElectronApplication | null = null

/**
 * A throwaway HTTP server on an OS-assigned loopback port, serving the three
 * pages these tests navigate between: the page the pane starts on, a second
 * local page, and a `/bounce` that answers 302 to a non-loopback origin.
 *
 * Local rather than a fixture `file://` URL, because a `file://` page is not
 * loopback (`isLoopbackUrl` refuses every non-http scheme) and would be
 * confined itself, and because `/bounce` needs a real redirect, which only a
 * server can send.
 */
function startServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const created = createServer((req, res) => {
      if (req.url === '/bounce') {
        res.writeHead(302, { Location: AWAY })
        res.end()
        return
      }
      res.setHeader('Content-Type', 'text/html')
      if (req.url === '/next') {
        res.end('<!doctype html><title>next</title><h1 id="marker">local-next-loaded</h1>')
        return
      }
      res.end(
        '<!doctype html><title>start</title><h1 id="marker">local-start-loaded</h1>' +
          `<a id="away" href="${AWAY}">away</a>` +
          `<a id="blank" href="${AWAY}" target="_blank">blank</a>` +
          '<a id="local" href="/next">local</a>' +
          '<a id="bounce" href="/bounce">bounce</a>',
      )
    })
    created.once('error', reject)
    created.listen(0, '127.0.0.1', () => {
      const address = created.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('startServer: no port assigned'))
        return
      }
      resolve({ server: created, baseUrl: `http://127.0.0.1:${address.port}/` })
    })
  })
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-mcp-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-mcp-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-mcp-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-mcp-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-mcp-claude-'))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })
  ;({ server, baseUrl } = await startServer())

  // One browser pane, on the local page, in its own tab row: the same shape
  // `CHANNELS.openBrowser` writes when the palette command opens one, so the
  // pane this restores is an ordinary browser pane and nothing about the
  // seeding is what makes it confined. `activeBrowserTabId` is what puts it
  // on screen: the browser region shows the project's active browser tab, and
  // a pane that is never mounted attaches no guest to confine.
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 9,
      projects: [
        {
          id: 'p1',
          name: 'demo',
          slug: 'demo',
          cwd: projectCwd,
          presets: [],
          activeTabId: null,
          activeBrowserTabId: PANE,
        },
      ],
      panes: [{ id: PANE, projectSlug: 'demo', cwd: projectCwd, type: 'browser', url: baseUrl }],
      tabs: [
        { id: PANE, groupId: PANE, activePaneId: PANE, layout: { dir: 'row', ratio: [1], kids: [PANE] } },
      ],
      activeProjectId: 'p1',
    }),
    'utf8',
  )
})

test.afterEach(async () => {
  // Idempotent: a test that closed its own app leaves a closed one here, and
  // closing it again resolves rather than throwing.
  await running?.close().catch(() => undefined)
  running = null
  await killServer(SOCKET)
  server?.close()
  server = null
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Launches the app, optionally with `PANE` owned by `OWNER`, and starts
 * collecting the main process's stderr straight away: a refusal logged
 * before a listener is attached would be lost, and the refusal is what these
 * tests wait on.
 */
async function launch(owned: boolean): Promise<{ app: ElectronApplication; stderr: () => string }> {
  const app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
    ...(owned ? { agentBrowserPane: `${PANE}:${OWNER}` } : {}),
  })
  running = app
  const stream = app.process().stderr
  if (!stream) throw new Error('launch: the Electron process has no stderr to read')
  let text = ''
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  return { app, stderr: () => text }
}

/**
 * The URL of the one live browser-pane guest, or null while there is not
 * exactly one. Filtering `getAllWebContents()` by `getType() === 'webview'`
 * is the mechanism `browser.spec.ts` measured; one pane is mounted in each
 * test here, so the count check is a guard on this file's own setup.
 */
async function guestUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
    return guests.length === 1 ? guests[0]!.getURL() : null
  })
}

/**
 * Clicks `selector` inside the one live guest, with a real user gesture (the
 * second argument to `executeJavaScript`), the same way `browser.spec.ts`
 * does and for the reason measured there.
 */
async function clickInGuest(app: ElectronApplication, selector: string): Promise<void> {
  await app.evaluate(async ({ webContents }, sel) => {
    const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
    if (guests.length !== 1) {
      throw new Error(`clickInGuest: expected exactly one browser guest, found ${guests.length}`)
    }
    await guests[0]!.executeJavaScript(`document.querySelector('${sel}')?.click()`, true)
  }, selector)
}

/**
 * Waits until the start page's links are actually in the guest.
 *
 * The URL alone is not enough, and this cost a run to find: `getURL()` answers
 * with the start page as soon as the navigation commits, which is before the
 * document has been parsed. A click dispatched in that window finds no
 * element, does nothing, and the test then waits ten seconds for a refusal
 * that was never going to come. Asking for one of the links is asking the
 * question the click depends on.
 */
async function waitForStartPage(app: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }) => {
          const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
          if (guests.length !== 1) return 'no guest'
          return guests[0]!.executeJavaScript(
            "location.href + (document.querySelector('#bounce') ? ' ready' : ' loading')",
          ) as Promise<string>
        }),
      { timeout: 20_000 },
    )
    .toBe(`${baseUrl} ready`)
}

test('a link to a non-loopback origin does not navigate an agent-owned pane', async () => {
  const { app, stderr } = await launch(true)
  await expect((await app.firstWindow()).getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  await waitForStartPage(app)

  await clickInGuest(app, '#away')

  // The refusal is the positive signal that the click was handled at all.
  await expect.poll(() => stderr(), { timeout: 10_000 }).toContain(
    `refused a non-loopback navigation to ${AWAY} in agent-owned browser pane ${PANE}`,
  )
  // And the pane is still on the page it was on, rather than showing an error
  // card for a request that was made anyway.
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})

test('a link to another local page still navigates an agent-owned pane', async () => {
  const { app, stderr } = await launch(true)
  await expect((await app.firstWindow()).getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  await waitForStartPage(app)

  await clickInGuest(app, '#local')

  await expect.poll(() => guestUrl(app), { timeout: 10_000 }).toBe(`${baseUrl}next`)
  expect(stderr()).not.toContain('refused a non-loopback navigation')

  await app.close()
})

test('a redirect off loopback does not move an agent-owned pane', async () => {
  const { app, stderr } = await launch(true)
  await expect((await app.firstWindow()).getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  await waitForStartPage(app)

  // `/bounce` is itself loopback, so `will-navigate` lets this start. Only
  // `will-redirect` sees where it was going, which is what makes this test
  // fail if that second listener is dropped.
  await clickInGuest(app, '#bounce')

  await expect.poll(() => stderr(), { timeout: 10_000 }).toContain(
    `refused a non-loopback navigation to ${AWAY} in agent-owned browser pane ${PANE}`,
  )
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})

test('the same link navigates a browser pane the user opened by hand', async () => {
  // No `agentBrowserPane`, so this pane carries no owner: the shape every
  // browser pane in the app has today. Without this test, confining every
  // pane in the app would pass everything above.
  const { app, stderr } = await launch(false)
  await expect((await app.firstWindow()).getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  await waitForStartPage(app)

  await clickInGuest(app, '#away')

  // Left the local page. Where it ends up depends on whether this machine can
  // reach example.com (an error page commits at the same URL when it cannot),
  // so the assertion is on the origin, not on the page loading.
  await expect
    .poll(() => guestUrl(app), { timeout: 20_000 })
    .toMatch(/^https:\/\/example\.com/)
  expect(stderr()).not.toContain('refused a non-loopback navigation')

  await app.close()
})

/**
 * The third route out of a page, and the one that escaped this confinement
 * until it was measured: a `target=_blank` click is answered by
 * `setWindowOpenHandler` (`src/main/index.ts`) loading the page in the same
 * guest, and Electron emits no `will-navigate` for a load main starts. With
 * only the two navigation listeners in place, this click landed the pane on
 * `https://example.com/` with nothing logged (measured 2026-08-12).
 */
test('a target=_blank link to a non-loopback origin does not navigate an agent-owned pane', async () => {
  const { app, stderr } = await launch(true)
  await expect((await app.firstWindow()).getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  await waitForStartPage(app)

  await clickInGuest(app, '#blank')

  await expect.poll(() => stderr(), { timeout: 10_000 }).toContain(
    `refused a non-loopback navigation to ${AWAY} in agent-owned browser pane ${PANE}`,
  )
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})
