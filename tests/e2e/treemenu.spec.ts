/**
 * The file tree's right-click menu, and a file dropped on the window.
 *
 * A file of its own rather than more tests in `filetree.spec.ts`: that file
 * asserts exact row counts (`[data-testid^="tree-row-"]` `toHaveCount(4)`)
 * across one shared page, and every test here creates, renames or deletes a
 * row. Sharing a page with those counts would couple two unrelated files
 * through the filesystem.
 *
 * One page for this file too, so each test leaves the tree as it found it, or
 * says in its own name what it changed.
 *
 * **What this file cannot see**: whether a real dropped file's path reaches the
 * pty. `webUtils.getPathForFile` resolves a `File` built inside a page to '',
 * so a synthetic drop carries no path by construction. The text a drop types
 * is covered by `tests/unit/shellQuote.test.ts`.
 *
 * It also cannot see Electron navigating to a dropped file. A test asserting
 * the window had not navigated was written first and thrown away: it passed
 * with the guard deliberately removed (measured 2026-08-07), because a
 * synthetic `DragEvent` never reaches that path. What the two drop tests
 * assert instead is the `preventDefault` the defence is actually made of.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-treemenu'

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
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-tm-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-tm-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-tm-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-tm-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-tm-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  await writeFile(join(projectCwd, 'src', 'app.ts'), 'const a = 1\n')
  await writeFile(join(projectCwd, 'keep.md'), '# keep\n')
  await writeFile(join(projectCwd, 'doomed.txt'), 'delete me\n')
  await writeFile(join(projectCwd, 'oldname.txt'), 'rename me\n')

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
  await expandColumn(page, 'files')
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

const exists = async (relPath: string): Promise<boolean> =>
  stat(join(projectCwd, relPath)).then(
    () => true,
    () => false,
  )

test('right-clicking a file row opens the menu, and a click elsewhere dismisses it', async () => {
  await expect(page.getByTestId('tree-row-keep.md')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('tree-row-keep.md').click({ button: 'right' })
  await expect(page.getByTestId('treemenu')).toBeVisible()
  // A file offers Open; the directory test below asserts the other side.
  await expect(page.getByTestId('treemenu-open')).toBeVisible()

  await page.getByTestId('tree-scroll').click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('treemenu')).toHaveCount(0)
})

test('a directory row is not offered Open, where a file is', async () => {
  await page.getByTestId('tree-row-src').click({ button: 'right' })
  await expect(page.getByTestId('treemenu')).toBeVisible()
  await expect(page.getByTestId('treemenu-open')).toHaveCount(0)
  // The control: the rest of the menu is there, so the absence above is about
  // Open rather than about the menu having failed to render.
  await expect(page.getByTestId('treemenu-rename')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('tree-scroll').click({ position: { x: 5, y: 5 } })
})

test('Copy path puts the absolute path on the clipboard, and Copy relative path the short one', async () => {
  await page.getByTestId('tree-row-keep.md').click({ button: 'right' })
  await page.getByTestId('treemenu-copy-path').click()
  // Read out of MAIN, which is the process that wrote it. `clipboard` is not
  // reachable from the page.
  await expect
    .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
    .toBe(join(projectCwd, 'keep.md'))

  await page.getByTestId('tree-row-keep.md').click({ button: 'right' })
  await page.getByTestId('treemenu-copy-relative').click()
  await expect
    .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
    .toBe('keep.md')
})

test('Rename renames the file on disk and the row with it', async () => {
  await page.getByTestId('tree-row-oldname.txt').click({ button: 'right' })
  await page.getByTestId('treemenu-rename').click()

  const field = page.getByTestId('tree-rename')
  await expect(field).toBeVisible()
  // The field starts on the current name, so a rename is an edit rather than
  // a retype.
  await expect(field).toHaveValue('oldname.txt')
  await field.fill('newname.txt')
  await field.press('Enter')

  await expect(page.getByTestId('tree-row-newname.txt')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('tree-row-oldname.txt')).toHaveCount(0)
  // On disk, not merely in the tree: the row could be right and the file wrong.
  expect(await exists('newname.txt')).toBe(true)
  expect(await exists('oldname.txt')).toBe(false)
  expect(await readFile(join(projectCwd, 'newname.txt'), 'utf8')).toBe('rename me\n')
})

test('a rename onto an existing name is refused, and neither file is touched', async () => {
  await page.getByTestId('tree-row-newname.txt').click({ button: 'right' })
  await page.getByTestId('treemenu-rename').click()
  const field = page.getByTestId('tree-rename')
  await field.fill('keep.md')
  await field.press('Enter')

  await expect(page.getByTestId('tree-error')).toBeVisible({ timeout: 10_000 })
  // The victim is intact, which is the whole point of the refusal.
  expect(await readFile(join(projectCwd, 'keep.md'), 'utf8')).toBe('# keep\n')
  expect(await exists('newname.txt')).toBe(true)
})

test('Escape leaves the rename field without renaming anything', async () => {
  await page.getByTestId('tree-row-keep.md').click({ button: 'right' })
  await page.getByTestId('treemenu-rename').click()
  const field = page.getByTestId('tree-rename')
  await field.fill('should-not-appear.md')
  await field.press('Escape')

  await expect(page.getByTestId('tree-rename')).toHaveCount(0)
  await expect(page.getByTestId('tree-row-keep.md')).toBeVisible()
  expect(await exists('should-not-appear.md')).toBe(false)
})

test('New file creates an empty file inside the directory that was clicked', async () => {
  await page.getByTestId('tree-row-src').click({ button: 'right' })
  await page.getByTestId('treemenu-new-file').click()

  const field = page.getByTestId('tree-create')
  await expect(field).toBeVisible()
  await field.fill('fresh.ts')
  await field.press('Enter')

  await expect(page.getByTestId('tree-row-src/fresh.ts')).toBeVisible({ timeout: 10_000 })
  expect(await readFile(join(projectCwd, 'src', 'fresh.ts'), 'utf8')).toBe('')
})

test('New folder creates a directory, and creating over an existing name is refused', async () => {
  await page.getByTestId('tree-row-src').click({ button: 'right' })
  await page.getByTestId('treemenu-new-folder').click()
  const field = page.getByTestId('tree-create')
  await field.fill('nested')
  await field.press('Enter')
  await expect(page.getByTestId('tree-row-src/nested')).toBeVisible({ timeout: 10_000 })
  expect((await stat(join(projectCwd, 'src', 'nested'))).isDirectory()).toBe(true)

  // And the refusal, which is what stops a New file emptying a real one.
  await page.getByTestId('tree-row-src').click({ button: 'right' })
  await page.getByTestId('treemenu-new-file').click()
  const again = page.getByTestId('tree-create')
  await again.fill('app.ts')
  await again.press('Enter')
  await expect(page.getByTestId('tree-error')).toBeVisible({ timeout: 10_000 })
  expect(await readFile(join(projectCwd, 'src', 'app.ts'), 'utf8')).toBe('const a = 1\n')
})

test('Move to Trash removes the row and the file', async () => {
  await expect(page.getByTestId('tree-row-doomed.txt')).toBeVisible()
  await page.getByTestId('tree-row-doomed.txt').click({ button: 'right' })
  await page.getByTestId('treemenu-delete').click()

  await expect(page.getByTestId('tree-row-doomed.txt')).toHaveCount(0, { timeout: 10_000 })
  expect(await exists('doomed.txt')).toBe(false)
})

/*
 * The half of the drop feature a test can see.
 *
 * NOT "the window did not navigate". That was tried first and was a passenger:
 * with the guard deliberately removed it still passed (measured 2026-08-07),
 * because a `DragEvent` dispatched from `page.evaluate` carries no real file
 * and never reaches the navigation Chromium would do for one. It asserted a
 * thing that cannot happen in a test rather than a thing the app does.
 *
 * What IS observable is our own handling: `preventDefault` on a cancelable
 * event makes `dispatchEvent` answer false. That is the exact call the whole
 * defence rests on — it is what stops Electron replacing the app with the
 * dropped file, and on a pane it is also what makes the element a drop target
 * at all — so asserting it is asserting the mechanism rather than the symptom.
 */
async function defaultPreventedOn(testid: string, type: 'dragover' | 'drop'): Promise<boolean> {
  return page.evaluate(
    ({ testid: id, type: kind }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['x'], 'dropped.txt', { type: 'text/plain' }))
      const target = document.querySelector(`[data-testid="${id}"]`)
      if (!target) throw new Error(`no element with testid ${id}`)
      const event = new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true })
      // `dispatchEvent` answers false exactly when something called
      // preventDefault on the way through.
      return !target.dispatchEvent(event)
    },
    { testid, type },
  )
}

test('a drag over the file tree is swallowed rather than left to Electron', async () => {
  expect(await defaultPreventedOn('tree-scroll', 'dragover')).toBe(true)
  expect(await defaultPreventedOn('tree-scroll', 'drop')).toBe(true)
})

/*
 * There is deliberately NO test here for the pane's own drop handling, and two
 * oracles were tried and thrown away before concluding that.
 *
 * `preventDefault` cannot tell it apart: the window guard above runs in the
 * capture phase for every target, so `dispatchEvent` answers false over a pane
 * whether or not the pane handles anything — measured, with the pane's
 * `onDragOver` deleted the assertion still passed. `dropEffect` cannot either:
 * a `DataTransfer` built in a page reads back `none` no matter what a handler
 * assigns, because the property only holds during a real drag operation.
 *
 * So the pane half of the feature rests on `tests/unit/shellQuote.test.ts` for
 * the text it types, and on a manual check for the drop itself. Better to say
 * that than to keep a test that cannot fail.
 */
