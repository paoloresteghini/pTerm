/**
 * Terminal path links: the real ⌘-click, and the main-side gate that decides
 * whether there was a link there to click.
 *
 * The click test is the only thing in the suite that exercises the gesture,
 * so it is worth what it costs. Everything about where to click is MEASURED
 * rather than assumed: the row and column come out of the pane's own buffer,
 * and the cell size comes from the screen rect divided by a column count read
 * back from a deliberately over-long line. Nothing here can be hard-coded.
 * The two renderers in this app disagree about cell width (138 vs 133 columns
 * has been measured), so a constant would put the click on the wrong
 * character and the test would fail for a reason that has nothing to do with
 * links. The WebGL renderer also leaves `.xterm-rows` empty, which is why
 * there is no element to target and the coordinates have to be built at all.
 *
 * `fsProbe` is asserted directly over the bridge because it is the gate: a
 * candidate is only underlined once main confirms it is a readable file, so a
 * regression there is either a link that fails when pressed or no links at
 * all, and neither is visible from the click test alone.
 *
 * `fsOpen`'s success path is deliberately never called. It hands the file to
 * macOS, which would open Preview on the test machine, and asserting that a
 * foreign application launched is not this suite's business. Its refusals are
 * asserted instead, which is the half that carries the containment rule.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-tpaths'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let outsideDir: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let page: Page

/** `window.pterm.fsProbe`, called in the renderer where the bridge lives. */
const probe = (relPaths: string[]): Promise<string[]> =>
  page.evaluate((paths) => window.pterm.fsProbe('id-t', paths), relPaths)

const open = (relPath: string): Promise<boolean> =>
  page.evaluate((path) => window.pterm.fsOpen('id-t', path), relPath)

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-tp-ud-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-tp-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-tp-proj-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-tp-cwd-'))
  outsideDir = await mkdtemp(join(tmpdir(), 'pterm-tp-out-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-tp-cs-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, '{}', 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-tp-home-'))

  // The fixture the probe answers about: one file at the root, one nested, one
  // directory, and one file outside the project entirely.
  await writeFile(join(projectCwd, 'hello.ts'), 'export const hello = 1\n', 'utf8')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  await writeFile(join(projectCwd, 'src', 'deep.ts'), 'export const deep = 2\n', 'utf8')
  await writeFile(join(outsideDir, 'secret.ts'), 'export const secret = 3\n', 'utf8')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-t', name: 'T', slug: 't', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-t',
      tabs: [],
    }),
    'utf8',
  )
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [
    userDataDir,
    configDir,
    projectsRoot,
    projectCwd,
    outsideDir,
    claudeSettingsDir,
    claudeHome,
  ]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cmd-clicking a path in terminal output opens it in an editor pane', async () => {
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })

  // The marker is upper-cased and the command line still holds `printf`, so
  // the output line can be told from the command line that produced it. Both
  // contain the path, and clicking the command line would prove nothing about
  // where the text came from.
  await page.keyboard.type('printf "SEE src/deep.ts HERE\\n"')
  await page.keyboard.press('Enter')
  const outputLines = (): Promise<number> =>
    page.evaluate(
      () =>
        (window.__ptermTerminalTexts?.() ?? [])[0]?.text
          .split('\n')
          .filter((line) => line.includes('SEE src/deep.ts HERE') && !line.includes('printf'))
          .length ?? 0,
    )
  await expect.poll(outputLines, { timeout: 20_000 }).toBeGreaterThan(0)

  // Columns, measured: print more characters than fit and read how many
  // landed on one line. See this file's header for why no constant will do.
  await page.keyboard.type('printf "%0.sx" {1..400}; printf "\\n"')
  await page.keyboard.press('Enter')
  const cols = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const lines = (window.__ptermTerminalTexts?.() ?? [])[0]?.text.split('\n') ?? []
      const full = lines.find((line) => /^x{100,}$/.test(line))
      if (full) return full.length
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return 0
  })
  expect(cols).toBeGreaterThan(20)

  const point = await page.evaluate(
    (columns) => {
      const screen = document.querySelector('.xterm-screen') as HTMLElement | null
      const lines = (window.__ptermTerminalTexts?.() ?? [])[0]?.text.split('\n') ?? []
      if (!screen) return null
      const row = lines.findIndex(
        (line) => line.includes('SEE src/deep.ts HERE') && !line.includes('printf'),
      )
      if (row === -1) return null
      const col = lines[row].indexOf('src/deep.ts')
      const rect = screen.getBoundingClientRect()
      const cellW = rect.width / columns
      const cellH = rect.height / lines.length
      // Mid-path rather than mid-first-character: an off-by-one in either
      // direction still lands inside the link, so a rounding difference
      // cannot make this test fail for the wrong reason.
      return { x: rect.x + (col + 5) * cellW, y: rect.y + (row + 0.5) * cellH }
    },
    cols,
  )
  expect(point).not.toBeNull()

  const tabsBefore = await page.locator('[data-testid^="tab-"]').count()
  await page.mouse.move(point!.x, point!.y)
  await page.keyboard.down('Meta')
  await page.mouse.click(point!.x, point!.y)
  await page.keyboard.up('Meta')

  // A new tab, showing the file the path named. Both halves: a count alone
  // would pass for any tab at all, and the content is what says the editor
  // resolved the same path the terminal printed.
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(tabsBefore + 1, {
    timeout: 10_000,
  })
  await expect(page.getByTestId('editor-content')).toContainText('export const deep = 2', {
    timeout: 10_000,
  })
})

test('the probe confirms real files and nothing else', async () => {
  // Every rejection in one call, so the answer is a subset rather than a
  // sequence of yes/no round trips that could each be right for the wrong
  // reason. Order is the input's, which is what lets the caller pair each
  // answer back to the cell it came from.
  expect(
    await probe(['hello.ts', 'src/deep.ts', 'src', 'missing.ts', 'src/missing.ts']),
  ).toEqual(['hello.ts', 'src/deep.ts'])
})

test('the probe refuses a path that leaves the project', async () => {
  // A relative climb, which is the shape `resolveInside` refuses lexically.
  // The file really is there and really is readable: the refusal is about
  // where it is, not about whether it exists, so this cannot pass merely
  // because the fixture was missing.
  const climb = `../${outsideDir.split('/').pop()}/secret.ts`
  expect(await probe([climb])).toEqual([])
  expect(await probe([join(outsideDir, 'secret.ts')])).toEqual([])

  // The control: the same call shape, with a path inside, does answer. Without
  // this the test above would pass against an `fsProbe` that always returns
  // an empty array.
  expect(await probe(['hello.ts'])).toEqual(['hello.ts'])
})

test('the probe answers nothing for an unknown project or an empty batch', async () => {
  expect(await probe([])).toEqual([])
  expect(await page.evaluate(() => window.pterm.fsProbe('nope', ['hello.ts']))).toEqual([])
})

test('the system opener refuses what the probe refuses', async () => {
  // Only the refusals. The success path hands the file to macOS and would
  // launch Preview on the machine running this suite.
  expect(await open(join(outsideDir, 'secret.ts'))).toBe(false)
  expect(await open('../elsewhere/secret.ts')).toBe(false)
  expect(await page.evaluate(() => window.pterm.fsOpen('nope', 'hello.ts'))).toBe(false)
})
