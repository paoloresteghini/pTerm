/**
 * Files in ⌘K, the pane's terminal menu, and the elapsed label.
 *
 * One file for the two because they share a launch and neither needs a seeded
 * state the other would disturb. A repo is made with `git init` and a
 * `.gitignore`, because the palette's file list comes from `git ls-files` and a
 * plain directory would exercise the fallback instead of the real path.
 *
 * **The elapsed label is deliberately not tested here.** It shows nothing under
 * a minute, on purpose, so a test would have to hold the suite for a minute of
 * wall time or reach a clock the renderer does not expose — `now` comes from
 * `Date.now` inside `App`. A test asserting the label is ABSENT right after an
 * event was considered and rejected: it passes just as well against a build
 * that never renders a label at all, which is the failure it would exist to
 * catch. The formatter's boundaries are covered in `tests/unit/elapsed.test.ts`
 * and the clock's behaviour, including the re-fire case that matters most, in
 * `tests/unit/registry.test.ts`.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, killServer, terminalTexts } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e-palette'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-pal-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-pal-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-pal-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-pal-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-pal-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  await mkdir(join(projectCwd, 'dist'), { recursive: true })
  await writeFile(join(projectCwd, 'src', 'widget.ts'), 'export const widget = 1\n')
  await writeFile(join(projectCwd, 'README.md'), '# demo\n')
  await writeFile(join(projectCwd, 'dist', 'widget.js'), 'built\n')
  await writeFile(join(projectCwd, '.gitignore'), 'dist/\n')
  await run('git', ['init', '-q'], { cwd: projectCwd })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: projectCwd })
  await run('git', ['config', 'user.name', 'Test'], { cwd: projectCwd })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [] }],
      tabs: [],
      activeProjectId: 'p1',
      activeTabId: null,
    }),
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
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

const openPalette = async (query: string): Promise<void> => {
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.getByTestId('palette-input').fill(query)
}

test('typing a filename offers the file', async () => {
  await openPalette('widget')
  await expect(page.getByTestId('palette-file-src/widget.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
})

/*
 * The reason the list comes from git rather than a walk. `dist/widget.js`
 * matches the query as well as the source file does and is a real file on
 * disk; only `.gitignore` excludes it, and nothing in this app's own filter
 * would have.
 */
test('a gitignored file is not offered', async () => {
  await openPalette('widget')
  await expect(page.getByTestId('palette-file-src/widget.ts')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('palette-file-dist/widget.js')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('an empty query offers no files, so the switcher is not buried', async () => {
  await openPalette('')
  await expect(page.getByTestId('palette-file-README.md')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('choosing a file opens it in an editor pane', async () => {
  await openPalette('widget')
  await page.getByTestId('palette-file-src/widget.ts').click()
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await expect(page.getByTestId('editor-content').first()).toContainText('export const widget', {
    timeout: 20_000,
  })
})

test('the pane menu offers terminal actions on a terminal and not on an editor', async () => {
  // The editor pane opened above is still the active one.
  const editorTab = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  await page.getByTestId(`pane-${editorTab}`).click({ button: 'right' })
  await expect(page.getByTestId(`pmenu-${editorTab}`)).toBeVisible()
  // No terminal actions, and the swatches still there: the absence is about
  // the pane's type, not about the menu having failed to open.
  await expect(page.getByTestId(`pmenu-copy-${editorTab}`)).toHaveCount(0)
  await expect(page.getByTestId(`pmenu-clear-${editorTab}`)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('titlebar').click()

  await page.getByTestId('new-tab').click()
  const terminal = page.getByTestId('terminal').last()
  await expect(terminal).toBeVisible({ timeout: 20_000 })
  const termTab = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  await page.getByTestId(`pane-${termTab}`).click({ button: 'right' })
  await expect(page.getByTestId(`pmenu-copy-${termTab}`)).toBeVisible()
  await expect(page.getByTestId(`pmenu-paste-${termTab}`)).toBeVisible()
  await expect(page.getByTestId(`pmenu-clear-${termTab}`)).toBeVisible()
  // Copy is disabled with nothing selected, which is the state a fresh pane
  // is in. The other items are not.
  await expect(page.getByTestId(`pmenu-copy-${termTab}`)).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByTestId('titlebar').click()
})

test('Paste writes the clipboard into the pane', async () => {
  const termTab = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  // Set from MAIN, which owns the clipboard; the page cannot reach it.
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-here'))

  await page.getByTestId(`pane-${termTab}`).click({ button: 'right' })
  await page.getByTestId(`pmenu-paste-${termTab}`).click()

  // Typed into the shell, not submitted: Paste sends the text and nothing else.
  await expect
    .poll(async () => (await terminalTexts(page)).join('\n'), { timeout: 20_000 })
    .toContain('echo pasted-here')
})
