/**
 * The WebGL budget: which panes hold a renderer that can draw Claude Code's
 * chrome, and what happens to the ones that give theirs up.
 *
 * Why this matters at all is a rendering fault nothing in this suite can see
 * directly. The DOM renderer cannot draw `customGlyphs`, so a pane that falls
 * back to it draws the block characters in Claude Code's context bar — and
 * `╭`, `⏺`, `⏵⏵` — as clipped slivers that read on screen as stray
 * underscores. That is a picture, not an assertion: `__ptermRenderers()` is
 * the closest thing to it a test can hold, and these tests assert the renderer
 * each pane got, not what it drew.
 *
 * **Measured 2026-08-08, in this app's own Electron.** Chromium allows 16 live
 * WebGL contexts per renderer process: 40 contexts created on canvases
 * attached to the document left exactly 16 alive, and the survivors were the
 * last 16 created. Past the cap `getContext` does not fail — Chromium
 * force-loses an existing context, by its own least-recently-DRAWN order, and
 * an idle Claude Code session draws nothing while it waits for a prompt. So
 * the pane Chromium takes from is routinely one somebody is looking at, and
 * xterm's fallback is permanent. The app keeping its own count under that cap
 * is what these tests are about.
 *
 * Five tests. Three of them turn the budget down to two, because eviction and
 * recovery are hard to reach at twelve through this UI — the tab bar scrolls
 * once enough entries are in it and puts `+` behind itself, and `App.tsx`
 * refuses a split that would leave a pane under 20 columns. At a budget of two
 * the third pane hits exactly the same path as the thirteenth would. A fourth
 * reaches past the app and takes a context out from under a pane on screen,
 * which is the one loss the budget cannot prevent. The last runs with no
 * override at all and drives sixteen panes in a resized window, so the number
 * the app actually ships is not taken on faith.
 *
 * **What this file does NOT see** — read off its own text unless a line says
 * measured:
 *
 * - **the glyphs.** Every assertion here is about which renderer a pane got.
 *   That a WebGL pane draws `⏵⏵` correctly and a DOM pane draws a sliver was
 *   established by looking at screenshots, and nothing automated re-checks it.
 * - **`focused` as a recency signal.** `Terminal.tsx` marks a pane used on
 *   focus as well as on its tab becoming visible, so that a split someone has
 *   been typing in outranks its idle neighbour. Nothing here has two panes on
 *   one tab competing for the last context, so deleting that `markUsed` leaves
 *   this file green.
 * - **what a recovered pane MEASURES.** The fourth test asserts the renderer
 *   comes back and says nothing about the re-fit that follows it. A size
 *   assertion there could not fail: the pane never re-measured while it was on
 *   the DOM renderer, so its columns are the WebGL ones either way.
 *
 * **Measured 2026-08-08**, so the first four are known to be load-bearing
 * rather than assumed: hardcoding `claimRenderer`'s budget past the cap fails
 * all of them; never evicting fails the first and third; letting a pane on
 * screen be evicted fails the second; deferring the claim until after the fit
 * fails the third on 133 columns where it should read 138. **Measured
 * 2026-08-10** for the context-loss test: dropping the recovery out of
 * `onContextLoss` leaves it red on `dom`.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { launchApp, killServer, sessionNames } from './harness'
import { WEBGL_PANE_BUDGET_DEFAULT } from '../../src/renderer/lib/webglBudget'

const run = promisify(execFile)

const SOCKET = 'pterm-e2e-webgl'

let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
    webglLimit: 2,
  })

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-webgl-ud-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-webgl-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-webgl-proj-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-webgl-cs-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, '{}', 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-webgl-home-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-webgl-cwd-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-w', name: 'W', slug: 'w', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-w',
      tabs: [],
    }),
    'utf8',
  )
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome, projectCwd]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** The renderer each mounted pane is on, in mount order. */
async function renderersOf(window: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  return window.evaluate(
    () =>
      (globalThis as unknown as { __ptermRenderers?: () => Record<string, string> }).__ptermRenderers?.() ??
      {},
  )
}

/**
 * What the app last told tmux this session's window measures. The ground
 * truth for the column count a pane pushed, read from outside the app.
 */
async function windowSize(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

/**
 * Open `count` more tabs, waiting for each one's terminal before opening the
 * next, and answer every tab testid on the bar afterwards.
 *
 * Counted from however many tabs are already there rather than from zero, so
 * the second test can add one to a bar that already holds two.
 */
async function openTabs(
  window: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  count: number,
): Promise<string[]> {
  const already = await window.locator('[data-testid^="tab-"]').count()
  for (let i = 0; i < count; i++) {
    await window.getByTestId('new-tab').click()
    await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(already + i + 1)
    await expect(window.getByTestId('terminal').last()).toBeVisible({ timeout: 20_000 })
  }
  return window
    .locator('[data-testid^="tab-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))
}

test('a pane past the budget takes its renderer from the pane nobody is using', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await openTabs(window, 3)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(3)

  const renderers = await renderersOf(window)
  const kinds = Object.values(renderers)
  // Three panes exist and exactly two hold a context: the budget is a cap on
  // how many are live at once, not a cap on how many panes there are.
  expect(kinds).toHaveLength(3)
  expect(kinds.filter((kind) => kind === 'webgl')).toHaveLength(2)
  // And it is the FIRST tab that gave one up. Asserted by position rather than
  // by count so that evicting the wrong pane — the one the third tab was
  // opened from, say — fails here instead of passing on the arithmetic.
  // `__ptermRenderers` is built from a Map filled in mount order, so index 0
  // is the tab opened first and index 2 the one on screen now.
  expect(kinds).toEqual(['dom', 'webgl', 'webgl'])
  await app.close()
})

test('a pane on screen is never the one asked to give up its renderer', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  // Two ⌘D, so one tab holds three panes and all three are on screen at once.
  // `:scope >` because a bare `pane-` prefix also matches `pane-divider` and
  // the per-pane dot and restart controls.
  for (const expected of [2, 3]) {
    await window.keyboard.press('Meta+d')
    await expect(
      window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
    ).toHaveCount(expected)
    await expect
      .poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 })
      .toBe(expected)
  }

  // Under a budget of two the third pane finds both holders on screen, and
  // there is no honest way to give it one: taking a context from a pane the
  // user is looking at would change the renderer under a terminal that is
  // being drawn. So the third goes without, which is the outcome the budget
  // buys — the alternative is not "everyone is fine", it is "somebody visible
  // breaks and it is not the pane that asked".
  const kinds = Object.values(await renderersOf(window))
  expect(kinds).toEqual(['webgl', 'webgl', 'dom'])
  await app.close()
})

test('a pane coming back on screen takes its renderer back, at the size it already had', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  const tabs = await openTabs(window, 2)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // Let both panes finish measuring themselves before anything is recorded.
  await window.waitForTimeout(1500)

  const names = (await sessionNames(SOCKET)).sort()
  const sizes = new Map<string, string>()
  for (const name of names) sizes.set(name, await windowSize(name))
  // The window is far wider than tmux's 80x24 default, so a pane that never
  // measured itself would be unmistakable here.
  expect([...sizes.values()]).not.toContain('80x24')

  // A third tab, which under a budget of two costs the first tab its context.
  await openTabs(window, 1)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(3)
  expect(Object.values(await renderersOf(window))[0]).toBe('dom')

  // Going back to the first tab has to buy the context back.
  await window.getByTestId(tabs[0]).click()
  await expect
    .poll(async () => Object.values(await renderersOf(window))[0], { timeout: 10_000 })
    .toBe('webgl')

  // And the pane has to still be the size it was. This is the half that
  // catches the real hazard: the two renderers do not agree on the width of a
  // cell — the WebGL renderer rounds it to whole device pixels (15 device, 7.5
  // css at a ratio of 2) where the DOM renderer uses the font's true advance
  // of about 7.8 — so a pane re-measured while it is on the wrong one pushes a
  // column count to tmux that its box cannot hold. Measured 2026-08-08 on a
  // 1035px pane: 138 columns against 132.
  await window.waitForTimeout(1500)
  for (const name of names) expect(`${name}: ${await windowSize(name)}`).toBe(`${name}: ${sizes.get(name)}`)

  await app.close()
})

/**
 * A context taken from a pane the user is LOOKING at.
 *
 * The one failure the budget cannot prevent, and the one this file used to say
 * it could not reach: the budget sits below Chromium's cap so the app never
 * causes it, but anything else in the renderer process asking for a context
 * still can, and then Chromium picks its victim by least-recently-DRAWN — an
 * idle Claude Code session waiting for a prompt draws nothing, so the pane it
 * takes from is routinely one somebody is reading.
 *
 * Before 2026-08-10 that was permanent. `onContextLoss` recorded `dom` and
 * stopped; the only re-claim in the app hangs off the `visible` effect, and
 * `visible` does not change for a pane that was already on screen, so nothing
 * re-ran and the pane drew Claude Code's chrome as underscore slivers until
 * the user happened to switch tabs and back. **Measured the same day** against
 * the packaged 0.3.7 build: fifteen panes settled at eleven live contexts
 * under a budget of twelve, and eleven is a count the app's own eviction
 * cannot produce.
 *
 * Reaching past the app into its canvases is what this test is for, and it is
 * the only honest way to provoke the case: `WEBGL_lose_context` is the same
 * event Chromium raises when it force-loses one.
 */
test('a pane that loses its context while on screen takes it back on its own', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  // Every warning the renderer prints, so the loss is known to have actually
  // happened rather than assumed from the renderer reading `webgl` at the end
  // — which is also what it reads if `loseContext` did nothing at all.
  const warnings: string[] = []
  window.on('console', (message) => warnings.push(message.text()))

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  await window.waitForTimeout(1500)
  expect(Object.values(await renderersOf(window))).toEqual(['webgl'])

  // Chromium hands back the SAME context object for a canvas that already has
  // one, so this reaches the live context the addon is drawing through rather
  // than making a second one.
  const lost = await window.evaluate(() => {
    let killed = 0
    for (const canvas of document.querySelectorAll('canvas')) {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      const extension = gl?.getExtension('WEBGL_lose_context')
      if (extension) {
        extension.loseContext()
        killed += 1
      }
    }
    return killed
  })
  expect(lost).toBeGreaterThan(0)

  // The pane's own handler ran, which is what makes the assertion below about
  // recovery and not about a loss that never landed.
  await expect
    .poll(() => warnings.filter((line) => line.includes('lost its WebGL context')).length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0)

  // Back on WebGL without the tab being touched. Nothing here clicks a tab or
  // changes `visible`: that path is the previous test's, and it is exactly the
  // path a user staring at one pane never takes.
  await expect
    .poll(async () => Object.values(await renderersOf(window))[0], { timeout: 15_000 })
    .toBe('webgl')

  await app.close()
})

/**
 * The other three tests all run with the budget turned down to two, which
 * means none of them can tell whether the number the app actually SHIPS is
 * wired to anything. This one launches without the override and drives sixteen
 * real panes at it.
 *
 * Sixteen panes need a bigger window than the 1280x800 the app opens at, for
 * two independent reasons, and both are UI limits rather than anything about
 * renderers: `App.tsx` refuses a column split that would leave a pane under 20
 * columns, which caps a 1280px window at three panes per tab; and the tab bar
 * scrolls once enough entries are in it, which puts `+` behind it and makes
 * the next tab unclickable. At 2400x1400 four tabs of four panes fit.
 */
test('the shipped budget is what sixteen real panes get', async () => {
  test.setTimeout(180_000)
  const app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  const window = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(2400, 1400)
  })
  await window.waitForTimeout(1000)

  let made = 0
  for (let tab = 0; tab < 4; tab++) {
    await window.getByTestId('new-tab').click()
    made += 1
    await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 30_000 }).toBe(made)
    for (let split = 0; split < 3; split++) {
      await window.keyboard.press('Meta+d')
      made += 1
      await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 30_000 }).toBe(made)
    }
  }
  await window.waitForTimeout(2000)

  const kinds = Object.values(await renderersOf(window))
  expect(kinds).toHaveLength(16)
  expect(kinds.filter((kind) => kind === 'webgl')).toHaveLength(WEBGL_PANE_BUDGET_DEFAULT)
  // And it is the four OLDEST panes that went without, not four arbitrary
  // ones: `__ptermRenderers` is built in mount order, so the first four
  // entries are the first tab's, which has been off screen the longest. The
  // four panes on screen — the last tab's — are all on WebGL, which is the
  // whole point of ordering this by use.
  expect(kinds.slice(0, 4)).toEqual(['dom', 'dom', 'dom', 'dom'])
  expect(kinds.slice(-4)).toEqual(['webgl', 'webgl', 'webgl', 'webgl'])

  await app.close()
})
