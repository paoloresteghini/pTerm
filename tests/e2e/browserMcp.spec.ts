/**
 * The browser MCP loop, end to end, and the confinement of the pane it opens.
 *
 * Everything here goes through the real path a Claude session takes: the
 * bridge script this app writes to disk (`src/main/mcp/bridge.ts`), spawned
 * as its own process on a system `node` exactly as Claude Code spawns it,
 * speaking JSON-RPC on stdio to reach the app over its unix socket. No
 * environment seam marks a pane as agent-owned: `browser_navigate` opening
 * the pane is what claims it, which is the whole of Task 8.
 *
 * (It replaced one: `PTERM_AGENT_BROWSER_PANE` seeded the ownership map for
 * Task 7's tests, because nothing else could reach the owned state yet. It
 * marked any pane id at all with no validation, which was tolerable while the
 * map could only restrict a pane and is not now that it authorises an agent
 * to drive one. Those tests are the confinement ones below, unchanged in what
 * they assert and re-pointed at the pane the tool actually creates.)
 *
 * Every confinement test drives a navigation with NO tool argument in it: a
 * link clicked inside the page, a redirect served by a page that was itself
 * loopback, a subframe, and a `target=_blank`. None has a `url` parameter for
 * a tool to check, which is the argument the pane-level rule rests on. The
 * one test that DOES check a tool argument is the last one, because
 * `loadURL` called from main emits no navigation event at all and the
 * pane-level rule cannot see it.
 *
 * Reading the guest goes main-side through `webContents.getAllWebContents()`,
 * the same mechanism and for the same measured reason as `browser.spec.ts`:
 * Playwright cannot enter a `<webview>`, `page.frames()` reports the guest as
 * `about:blank` and `frameLocator` throws.
 *
 * A refusal is reported on the main process's stderr, and the tests poll for
 * that line rather than waiting a fixed time for nothing to happen: "the pane
 * did not move" is otherwise a claim that is true before the click as well as
 * after it.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { CHANNELS, type MenuCommand } from '../../src/shared/ipc'

const SOCKET = 'pterm-e2e-browsermcp'

// A typed assignment, not a bare string, for the reason `settingsTabs.spec.ts`
// gives: a renamed variant fails to compile here rather than sending a command
// nothing listens for.
const SETTINGS_COMMAND: MenuCommand = 'settings'

/**
 * The key the app owns inside `mcpServers`, spelled out rather than imported
 * from `src/main/mcp/install.ts`.
 *
 * This is the name Claude Code itself reads out of the file, so a test that
 * took it from the module would agree with a rename that broke every existing
 * session's tool. Spelling it is the assertion.
 */
const SERVER_KEY = 'pterm-browser'

/** The browser pane the CONTROL test seeds: one the user opened by hand. */
const HAND_OPENED = 'b1'

/**
 * The origin a confined pane must not reach.
 *
 * The confined tests never load it, and that is their point: the navigation
 * is refused before a request is made, and they assert on the refusal line
 * and on the pane not having moved. The one test that does reach the network
 * is the unowned control ("the same link navigates a browser pane the user
 * opened by hand"), which has to: what it proves is that a pane no agent owns
 * really does leave loopback, so a machine that cannot reach this origin is
 * the whole question. It stays green offline anyway because it asserts on the
 * origin the guest ends up at rather than on the page loading, and a load
 * that fails commits an error page at the URL it failed on (measured
 * 2026-08-12 against a host that cannot resolve: `ERR_NAME_NOT_RESOLVED`, and
 * `getURL()` still answered with that URL).
 */
const AWAY = 'https://example.com/'

/**
 * How that origin appears in a refusal line. `refusesNonLoopback` logs the
 * origin rather than the full URL, so this is `AWAY` without its path.
 */
const AWAY_ORIGIN = 'https://example.com'

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
 * A throwaway HTTP server on an OS-assigned loopback port, serving the pages
 * these tests navigate between: the page the pane starts on, a second local
 * page, a `/bounce` that answers 302 to a non-loopback origin, and a
 * `/framed` that puts that origin in an iframe.
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
      // A loopback page that frames a remote origin: the page an agent with a
      // shell can write and serve, and the reason the confinement cannot stop
      // at the main frame. The iframe starts on `about:blank` and is pointed
      // at `AWAY` from script, so the pane's own navigation to this page is
      // finished and asserted before the subframe navigation begins.
      if (req.url === '/framed') {
        res.end(
          '<!doctype html><title>framed</title><h1 id="marker">local-framed-loaded</h1>' +
            '<iframe id="fr" src="about:blank"></iframe>' +
            `<button id="frame-away" onclick="document.getElementById('fr').src='${AWAY}'">go</button>`,
        )
        return
      }
      res.end(
        '<!doctype html><title>start</title><h1 id="marker">local-start-loaded</h1>' +
          `<a id="away" href="${AWAY}">away</a>` +
          `<a id="blank" href="${AWAY}" target="_blank">blank</a>` +
          '<a id="local" href="/next">local</a>' +
          '<a id="bounce" href="/bounce">bounce</a>' +
          '<a id="framed" href="/framed">framed</a>',
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

/**
 * The config the app starts from: one project, and whichever panes a test
 * needs seeded.
 *
 * The agent tests seed none. That is deliberate and is half of what they
 * prove: the browser pane they drive does not exist until `browser_navigate`
 * creates it, so nothing about the seeding can be what makes it confined.
 */
async function writeConfig(seeded: { panes: unknown[]; tabs: unknown[]; activeBrowserTabId: string | null }): Promise<void> {
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
          activeBrowserTabId: seeded.activeBrowserTabId,
        },
      ],
      panes: seeded.panes,
      tabs: seeded.tabs,
      activeProjectId: 'p1',
    }),
    'utf8',
  )
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

  await writeConfig({ panes: [], tabs: [], activeBrowserTabId: null })
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
 * Launches the app and starts collecting the main process's stderr straight
 * away: a refusal logged before a listener is attached would be lost, and the
 * refusal is what these tests wait on.
 */
async function launch(): Promise<{ app: ElectronApplication; window: Page; stderr: () => string }> {
  const app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  running = app
  const stream = app.process().stderr
  if (!stream) throw new Error('launch: the Electron process has no stderr to read')
  let text = ''
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  const window = await app.firstWindow()
  await expect(window.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
  return { app, window, stderr: () => text }
}

/**
 * Opens a terminal tab and answers with its pane id, which is what a Claude
 * session running in it would carry as `PTERM_TAB_ID`.
 *
 * A real pane rather than a seeded config row, because a saved terminal row
 * whose tmux session is gone is pruned by restore (`restoreWorkspace`) and
 * would not be in the config the tool call routes against. The tab bar is
 * where its id is legible: `[data-testid^="tab-"]` is one element per
 * terminal tab, which is how the rest of this suite counts them.
 */
async function openSessionPane(window: Page): Promise<string> {
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const ids = await window
    .locator('[data-testid^="tab-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute('data-testid') ?? '').slice('tab-'.length)),
    )
  expect(ids).toHaveLength(1)
  return ids[0]!
}

/**
 * Opens Settings on the Hooks tab, which is where the browser bridge's switch
 * lives, and waits for the switch to have read its own state.
 *
 * The menu command is sent to the renderer directly, the way
 * `settingsTabs.spec.ts` does it: the accelerator cannot be driven from
 * Playwright (a synthetic keypress arrives below the layer Electron matches
 * accelerators at) and the menu bar is not in the DOM.
 */
async function openBridgeSwitch(app: ElectronApplication, window: Page): Promise<void> {
  expect(CHANNELS.menuCommand).toBe('pterm:menuCommand')
  expect(SETTINGS_COMMAND).toBe('settings')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })
  await expect(window.getByTestId('settings-pane')).toBeVisible({ timeout: 20_000 })
  await window.getByTestId('settings-tab-hooks').click()
  await expect(window.getByTestId('mcp-status')).toBeVisible()
}

/**
 * Whether the app's entry is in the Claude config this launch was pointed at.
 *
 * Read off disk rather than asked of the app, because the file is the whole
 * point: it is what a Claude session's own client reads at startup.
 */
async function registered(): Promise<boolean> {
  const raw = await readFile(join(configDir, 'claude.json'), 'utf8').catch(() => '{}')
  const servers = (JSON.parse(raw) as { mcpServers?: Record<string, unknown> }).mcpServers
  return servers !== undefined && SERVER_KEY in servers
}

/** What one `tools/call` answered with, unwrapped to its text and error flag. */
interface ToolReply {
  text: string
  isError: boolean
}

/**
 * Calls `browser_navigate` the way Claude Code would: the installed bridge
 * script, spawned on this machine's `node`, handed only `PTERM_MCP_SOCKET`
 * and `PTERM_TAB_ID`, spoken to in JSON-RPC over its stdin.
 *
 * The whole handshake is sent, in order, because that is what a client sends
 * and a bridge that only worked when addressed out of order would be no use.
 * `process.execPath` under Playwright is node itself.
 */
function callNavigate(paneId: string, url: string): Promise<ToolReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(configDir, 'bin', 'pterm-mcp')], {
      env: {
        PATH: process.env.PATH ?? '',
        PTERM_MCP_SOCKET: join(configDir, 'mcp.sock'),
        PTERM_TAB_ID: paneId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let errors = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`the bridge did not answer in 30s. stdout: ${out} stderr: ${errors}`))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      errors += chunk
    })
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue
        const message = JSON.parse(line) as {
          id?: number
          result?: { content?: { text: string }[]; isError?: boolean }
        }
        // id 2 is the `tools/call` below; id 1 is the initialize handshake.
        if (message.id !== 2) continue
        clearTimeout(timer)
        child.kill()
        resolve({
          text: (message.result?.content ?? []).map((entry) => entry.text).join('\n'),
          isError: message.result?.isError === true,
        })
        return
      }
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url } },
      })}\n`,
    )
  })
}

/** The pane id out of a successful reply, whose text is `{paneId, url}`. */
function paneIdOf(reply: ToolReply): string {
  expect(reply.isError).toBe(false)
  return (JSON.parse(reply.text) as { paneId: string }).paneId
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
 * The URLs of the one live guest's subframes, main frame excluded, or null
 * while there is not exactly one guest. Read main-side through
 * `mainFrame.frames` for the same measured reason as `guestUrl`.
 */
async function subframeUrls(app: ElectronApplication): Promise<string[] | null> {
  return app.evaluate(({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
    if (guests.length !== 1) return null
    return guests[0]!.mainFrame.frames.map((frame) => frame.url)
  })
}

/**
 * Waits until the guest is on `url` AND `selector` is actually in its
 * document.
 *
 * The URL alone is not enough, and this cost a run to find: `getURL()` answers
 * with the page as soon as the navigation commits, which is before the
 * document has been parsed. A click dispatched in that window finds no
 * element, does nothing, and the test then waits ten seconds for a refusal
 * that was never going to come. Asking for the element is asking the question
 * the click depends on.
 */
async function waitForGuestPage(
  app: ElectronApplication,
  url: string,
  selector: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }, sel) => {
          const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
          if (guests.length !== 1) return 'no guest'
          return guests[0]!.executeJavaScript(
            `location.href + (document.querySelector('${sel}') ? ' ready' : ' loading')`,
          ) as Promise<string>
        }, selector),
      { timeout: 20_000 },
    )
    .toBe(`${url} ready`)
}

/**
 * The whole opening move of every agent test: a session pane, a
 * `browser_navigate` to the local start page, and the pane id it created,
 * with its page ready to click.
 */
async function agentOnStartPage(
  app: ElectronApplication,
  window: Page,
): Promise<{ sessionId: string; paneId: string }> {
  const sessionId = await openSessionPane(window)
  const paneId = paneIdOf(await callNavigate(sessionId, baseUrl))
  await waitForGuestPage(app, baseUrl, '#bounce')
  return { sessionId, paneId }
}

test('browser_navigate opens a browser pane for the calling session and reuses it after', async () => {
  const { app, window } = await launch()
  const sessionId = await openSessionPane(window)

  // No browser pane exists at all at this point: the config seeded none and
  // the user has opened none.
  expect(await guestUrl(app)).toBeNull()

  const first = await callNavigate(sessionId, baseUrl)
  const paneId = paneIdOf(first)

  expect(first.text).toContain(baseUrl)
  await expect(window.getByTestId(`browserpane-${paneId}`)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toBe(baseUrl)

  // The second call routes to the pane the first one claimed rather than
  // minting another: `browserPaneFor` matches on the ownership this app
  // recorded, which is the only reason it can tell that pane from any other.
  const second = await callNavigate(sessionId, `${baseUrl}next`)
  expect(paneIdOf(second)).toBe(paneId)
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toBe(`${baseUrl}next`)

  await app.close()
})

/**
 * The off switch, through the real UI and against the real socket.
 *
 * The control comes first and is not decoration: the same call that fails
 * after the click succeeds before it, so what the failure demonstrates is the
 * switch rather than a bridge that never worked in this test.
 *
 * The failing call is the demonstration the ruling asked for. An assertion
 * that the entry is gone from `~/.claude.json` would not be one: a session
 * with a shell can put that entry back itself, and the reason off has to stop
 * the socket is that only a server which is not accepting actually denies it.
 * The bridge script here is spawned with `PTERM_MCP_SOCKET` pointing straight
 * at the socket path, exactly as the registration would, so it is reaching the
 * socket directly and not through anything the config still says.
 *
 * Turning it back on is asserted in the same test and on the same launch,
 * because "immediate in both directions" is the claim: no relaunch happens
 * between the last two calls.
 */
test('the Settings switch stops the socket serving, and turning it back on rebinds it', async () => {
  const { app, window } = await launch()
  const sessionId = await openSessionPane(window)

  // The control: on by default, registered by the launch, and serving.
  expect(await registered()).toBe(true)
  expect((await callNavigate(sessionId, baseUrl)).isError).toBe(false)

  await openBridgeSwitch(app, window)
  await expect(window.getByTestId('mcp-status')).toHaveText('on')
  await window.getByTestId('mcp-disable').click()
  await expect(window.getByTestId('mcp-status')).toHaveText('off')

  expect(await registered()).toBe(false)
  const denied = await callNavigate(sessionId, baseUrl)
  expect(denied.isError).toBe(true)
  // The bridge's own words for a socket that refused the connection. It is
  // what the model reads, and it is the difference between denied and hung.
  expect(denied.text).toContain('pTerm is not running')

  await window.getByTestId('mcp-enable').click()
  await expect(window.getByTestId('mcp-status')).toHaveText('on')

  expect(await registered()).toBe(true)
  const again = await callNavigate(sessionId, `${baseUrl}next`)
  expect(again.isError).toBe(false)
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toBe(`${baseUrl}next`)

  await app.close()
})

/**
 * The half a preference exists for: the next launch must not put back what the
 * user took away.
 *
 * Two launches against one config directory, with the app closed in between,
 * so the second one reads the decision off disk exactly as a real relaunch
 * does. The first launch opens no pane at all, which keeps the second one's
 * `openSessionPane` looking at a tab bar with one tab in it.
 *
 * The stderr assertion is the control for the silence. A relaunch that failed
 * to bind its socket for some unrelated reason would deny the call in exactly
 * the same way, and this is what tells the two apart: the launch says nothing
 * about a server it could not start, because it never tried to start one.
 */
test('the off state survives a relaunch, which does not put the registration back', async () => {
  const first = await launch()
  await openBridgeSwitch(first.app, first.window)
  await expect(first.window.getByTestId('mcp-status')).toHaveText('on')
  expect(await registered()).toBe(true)

  await first.window.getByTestId('mcp-disable').click()
  await expect(first.window.getByTestId('mcp-status')).toHaveText('off')
  await first.app.close()

  const { app, window, stderr } = await launch()

  await openBridgeSwitch(app, window)
  await expect(window.getByTestId('mcp-status')).toHaveText('off')
  expect(await registered()).toBe(false)

  // The dialog draws a full-screen overlay that swallows clicks, so it has to
  // go before a tab can be opened underneath it.
  await window.keyboard.press('Escape')
  await expect(window.getByTestId('settings-pane')).toHaveCount(0)

  const sessionId = await openSessionPane(window)
  const denied = await callNavigate(sessionId, baseUrl)
  expect(denied.isError).toBe(true)
  expect(denied.text).toContain('pTerm is not running')
  expect(stderr()).not.toContain('failed to start the MCP browser server')

  await app.close()
})

/**
 * The launch path, which reads a file this app does not own.
 *
 * `installMcpBridge` registers the bridge, or re-points a stale registration,
 * on every launch that finds the switch on (task 8b, and task 10 for the
 * switch), and it THROWS on a `~/.claude.json` that cannot
 * be read, does not parse, or does not hold a JSON object. That file is the
 * user's own, 191KB of it on this machine, and it is edited by other tools;
 * a corrupt one must cost the browser tool and nothing else. The harness
 * points `PTERM_MCP_CONFIG` at `configDir/claude.json` (see `launchApp`),
 * which is the file written here.
 *
 * Both halves are asserted, because a window that opens over a bridge that
 * quietly did not install itself is the failure this is really about: the app
 * comes up, it says on stderr what it could not do, and the tool still works,
 * since the script and the socket do not depend on that file at all.
 */
test('a corrupt Claude config costs the registration and not the app', async () => {
  await writeFile(join(configDir, 'claude.json'), '{ this is not JSON', 'utf8')

  const { app, window, stderr } = await launch()
  const sessionId = await openSessionPane(window)

  await expect
    .poll(() => stderr(), { timeout: 10_000 })
    .toContain('could not register the MCP browser bridge')
  expect(await guestUrl(app)).toBeNull()

  const reply = await callNavigate(sessionId, baseUrl)
  expect(reply.isError).toBe(false)
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toBe(baseUrl)

  await app.close()
})

/**
 * The tool's own argument, which is the one route into a pane that Task 7's
 * confinement cannot see: `loadURL` called from main emits no
 * `will-navigate`, `will-redirect` or `will-frame-navigate`. Without the
 * check in `planBrowserNavigate` this is simply how an agent reaches any
 * origin it likes.
 *
 * The pane must also not be created, which is the second assertion: a refusal
 * that had already minted a claimed pane would leave an agent holding one.
 */
test('browser_navigate refuses a non-loopback URL and opens no pane at all', async () => {
  const { app, window } = await launch()
  const sessionId = await openSessionPane(window)

  const reply = await callNavigate(sessionId, AWAY)

  expect(reply.isError).toBe(true)
  expect(reply.text).toContain('loopback')
  expect(await guestUrl(app)).toBeNull()

  await app.close()
})

test('a link to a non-loopback origin does not navigate an agent-owned pane', async () => {
  const { app, window, stderr } = await launch()
  const { paneId } = await agentOnStartPage(app, window)

  await clickInGuest(app, '#away')

  // The refusal is the positive signal that the click was handled at all.
  await expect
    .poll(() => stderr(), { timeout: 10_000 })
    .toContain(`refused a non-loopback navigation to ${AWAY_ORIGIN} in agent-owned browser pane ${paneId}`)
  // And the pane is still on the page it was on, rather than showing an error
  // card for a request that was made anyway.
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})

/**
 * The permissive half of Task 7's confinement: the listeners are attached and
 * a loopback link goes through them rather than around them.
 *
 * The strip assertion is what makes the other two mean anything. A pane the
 * listeners never saw, and a pane no agent owns, both navigate to a local
 * link and both write nothing to stderr, so on their own the two assertions
 * below pass against a browser pane with no confinement on it at all: they
 * would be a test of an ordinary browser pane wearing this test's name.
 * `agentstrip-` is drawn only where `agentSessionId` is set, which is the
 * same map `refusesNonLoopback` reads.
 */
test('a link to another local page still navigates an agent-owned pane', async () => {
  const { app, window, stderr } = await launch()
  const { paneId } = await agentOnStartPage(app, window)
  await expect(window.getByTestId(`agentstrip-${paneId}`)).toBeVisible({ timeout: 20_000 })

  await clickInGuest(app, '#local')

  await expect.poll(() => guestUrl(app), { timeout: 10_000 }).toBe(`${baseUrl}next`)
  expect(stderr()).not.toContain('refused a non-loopback navigation')
  // Still owned after the navigation it was allowed to make, so what went
  // through was an agent-owned pane's navigation and not an unowned one's.
  await expect(window.getByTestId(`agentstrip-${paneId}`)).toHaveCount(1)

  await app.close()
})

test('a redirect off loopback does not move an agent-owned pane', async () => {
  const { app, window, stderr } = await launch()
  const { paneId } = await agentOnStartPage(app, window)

  // `/bounce` is itself loopback, so `will-navigate` lets this start. Only
  // `will-redirect` sees where it was going, which is what makes this test
  // fail if that second listener is dropped.
  await clickInGuest(app, '#bounce')

  await expect
    .poll(() => stderr(), { timeout: 10_000 })
    .toContain(`refused a non-loopback navigation to ${AWAY_ORIGIN} in agent-owned browser pane ${paneId}`)
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})

/**
 * The fourth route out of a page, and the one an agent with a shell reaches
 * most easily: it can author and serve a loopback page that frames any remote
 * origin. `will-navigate` is main-frame only, so the confinement has to be on
 * `will-frame-navigate` as well or the frame lands wherever it likes inside a
 * confined pane and whatever reads the pane back reads that.
 *
 * The pane's own navigation (to the framing page) is loopback and is asserted
 * to succeed first, so a refusal seen afterwards can only be the subframe's.
 */
test('an iframe to a non-loopback origin does not load in an agent-owned pane', async () => {
  const { app, window, stderr } = await launch()
  const { paneId } = await agentOnStartPage(app, window)

  await clickInGuest(app, '#framed')
  await waitForGuestPage(app, `${baseUrl}framed`, '#frame-away')
  expect(stderr()).not.toContain('refused a non-loopback navigation')

  await clickInGuest(app, '#frame-away')

  await expect
    .poll(() => stderr(), { timeout: 10_000 })
    .toContain(`refused a non-loopback navigation to ${AWAY_ORIGIN} in agent-owned browser pane ${paneId}`)
  // The frame never left where it started, rather than loading and being
  // reported after the fact.
  expect(await subframeUrls(app)).toEqual(['about:blank'])
  // And the pane itself is still on the framing page.
  expect(await guestUrl(app)).toBe(`${baseUrl}framed`)

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
  const { app, window, stderr } = await launch()
  const { paneId } = await agentOnStartPage(app, window)

  await clickInGuest(app, '#blank')

  await expect
    .poll(() => stderr(), { timeout: 10_000 })
    .toContain(`refused a non-loopback navigation to ${AWAY_ORIGIN} in agent-owned browser pane ${paneId}`)
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})

/**
 * The strip, which is the only place the user is told a browser pane is not
 * theirs.
 *
 * Both halves are in one test deliberately. The absence half is a control, and
 * on its own it passes for all the wrong reasons: against a strip that is
 * never drawn anywhere, against a testid nobody spells that way, and against a
 * hand-opened pane that is not on screen to have been given one. The three
 * assertions before it are what make its silence worth anything: the agent's
 * pane HAS a strip under this exact testid, that strip names the call, and the
 * hand-opened pane is mounted at the moment it is asked about.
 *
 * Measured with `BrowserPane`'s `agentSessionId &&` guard removed, so every
 * browser pane drew a strip: this test failed on the `toHaveCount(0)` below
 * and every other test in this file still passed.
 */
test("the strip names the agent's last call, and a pane the user opened by hand has none", async () => {
  await writeConfig({
    panes: [{ id: HAND_OPENED, projectSlug: 'demo', cwd: projectCwd, type: 'browser', url: baseUrl }],
    tabs: [
      {
        id: HAND_OPENED,
        groupId: HAND_OPENED,
        activePaneId: HAND_OPENED,
        layout: { dir: 'row', ratio: [1], kids: [HAND_OPENED] },
      },
    ],
    activeBrowserTabId: HAND_OPENED,
  })
  const { app, window } = await launch()
  await expect(window.getByTestId(`browserpane-${HAND_OPENED}`)).toBeVisible({ timeout: 20_000 })

  const sessionId = await openSessionPane(window)
  const paneId = paneIdOf(await callNavigate(sessionId, `${baseUrl}next`))

  const strip = window.getByTestId(`agentstrip-${paneId}`)
  await expect(strip).toBeVisible({ timeout: 20_000 })
  // The marker, which is the half of this strip that is always there: a pane
  // is not the user's whether or not anything has happened in it yet. Asserted
  // because it is a requirement in its own right, and deleting the span that
  // draws it passed every other assertion in this file.
  await expect(strip).toContainText('agent')
  // The call, not the pane's current page: the two agree here, and the strip
  // is fed by the tool rather than by `did-navigate`, which is the difference
  // that matters when a page moves itself afterwards.
  await expect(strip).toContainText(`${baseUrl}next`, { timeout: 20_000 })

  // Still mounted, so the absence below is about ownership rather than about
  // a pane that has gone: opening the agent's pane makes its tab the active
  // one, and `BrowserColumn` hides a pane rather than unmounting it.
  await expect(window.getByTestId(`browserpane-${HAND_OPENED}`)).toHaveCount(1)
  await expect(window.getByTestId(`agentstrip-${HAND_OPENED}`)).toHaveCount(0)

  await app.close()
})

/**
 * The strip survives a reply that has nothing to say about ownership.
 *
 * `agentSessionId` is stripped off every row `store.read()` returns
 * (`normalisePane`), so every reply main builds from config arrives without
 * it, and the renderer's reducers replace a pane record wholesale with what
 * the reply carries. Renaming ANY tab in the app therefore used to clear the
 * flag on every agent-owned browser pane, and the strip went with it: the pane
 * stayed owned, stayed confined and stayed the agent's, and only the telling
 * stopped. Measured before the fix, exactly this test: `toHaveCount(0)` where 1
 * was expected.
 *
 * The tab renamed here is the SESSION's terminal tab, not the browser pane,
 * which is the point: the reply is a list of every pane on disk, so the blast
 * radius is every agent-owned pane in the window rather than the one that was
 * touched.
 *
 * The rename is asserted to have landed before the strip is counted. Without
 * that, a rename that silently did nothing would leave this test passing for
 * the one reason it must not.
 */
test("renaming a tab elsewhere leaves the strip on the agent's pane", async () => {
  const { app, window } = await launch()
  const { sessionId, paneId } = await agentOnStartPage(app, window)
  await expect(window.getByTestId(`agentstrip-${paneId}`)).toBeVisible({ timeout: 20_000 })

  await window.getByTestId(`tablabel-${sessionId}`).dblclick()
  const field = window.getByTestId(`tabinput-${sessionId}`)
  await field.fill('payments api')
  await field.press('Enter')
  await expect(window.getByTestId(`tab-${sessionId}`)).toContainText('payments api')

  await expect(window.getByTestId(`agentstrip-${paneId}`)).toHaveCount(1)

  await app.close()
})

/**
 * What a refusal looks like to the user, which until this task was a line on a
 * stderr nobody running the app reads: the pane stays where it was, which on
 * its own is indistinguishable from a link that did nothing.
 *
 * By origin, not by the whole URL, for the reasons `refusesNonLoopback` gives:
 * the full text carries the query string, and the page can write this line as
 * often as it likes.
 */
test('a refused navigation shows in the strip as blocked, naming the origin', async () => {
  const { app, window } = await launch()
  const { paneId } = await agentOnStartPage(app, window)

  const strip = window.getByTestId(`agentstrip-${paneId}`)
  await expect(strip).toContainText(baseUrl, { timeout: 20_000 })
  await expect(strip).not.toContainText('blocked')

  await clickInGuest(app, '#away')

  await expect(strip).toContainText(`blocked: ${AWAY_ORIGIN}`, { timeout: 20_000 })
  // The pane did not move either, so what the strip is reporting is the
  // refusal and not a navigation that happened anyway.
  expect(await guestUrl(app)).toBe(baseUrl)

  await app.close()
})

/**
 * The control, and the test that keeps every one above honest: a browser pane
 * the user opened by hand carries no owner, and confining every pane in the
 * app would pass all of them without it.
 *
 * It is also the second half of the routing rule. The session pane opened
 * here calls the tool while this hand-opened pane is sitting in the same
 * project, and the tool creates a pane of its own rather than taking this
 * one, which is the decision from brainstorming: the agent drives its own
 * browser pane, never the user's.
 */
test('the same link navigates a browser pane the user opened by hand, which the tool never claims', async () => {
  await writeConfig({
    panes: [{ id: HAND_OPENED, projectSlug: 'demo', cwd: projectCwd, type: 'browser', url: baseUrl }],
    tabs: [
      {
        id: HAND_OPENED,
        groupId: HAND_OPENED,
        activePaneId: HAND_OPENED,
        layout: { dir: 'row', ratio: [1], kids: [HAND_OPENED] },
      },
    ],
    activeBrowserTabId: HAND_OPENED,
  })
  const { app, window, stderr } = await launch()
  await expect(window.getByTestId(`browserpane-${HAND_OPENED}`)).toBeVisible({ timeout: 20_000 })
  await waitForGuestPage(app, baseUrl, '#away')

  // While this is still the only guest in the app, so `clickInGuest` and
  // `guestUrl` are asking about it and nothing else.
  await clickInGuest(app, '#away')

  // Left the local page. Where it ends up depends on whether this machine can
  // reach example.com (an error page commits at the same URL when it cannot),
  // so the assertion is on the origin, not on the page loading.
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toMatch(/^https:\/\/example\.com/)
  expect(stderr()).not.toContain('refused a non-loopback navigation')

  // And the pane is not something a session can take over by asking: the tool
  // opens one of its own, in the same project, with this one sitting there.
  const sessionId = await openSessionPane(window)
  const claimed = paneIdOf(await callNavigate(sessionId, `${baseUrl}next`))
  expect(claimed).not.toBe(HAND_OPENED)

  await app.close()
})
