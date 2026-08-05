/**
 * Clicking a file in the tree, and the pane that opens.
 *
 * The first thing in this slice with anything on screen. Everything asserted
 * here is the rendered result of a real click: the tab that appears, the file's
 * own text inside the pane, and what a pane whose file has gone says instead.
 *
 * `beforeAll`/`afterAll` with one app and one `page` for the whole file, like
 * `filetree.spec.ts` and unlike `editorRestore.spec.ts`'s per-test temp dirs.
 * These tests are a sequence (the second reads the tab the first opened), so a
 * fresh app per test would have to re-do the click anyway, and the last test
 * needs a pane that was opened through the UI before it reloads the window.
 * A `-g` filtered run of one test here proves nothing; believe the whole-file
 * run.
 *
 * **One failure in this file invalidates every test after it, and the reason is
 * not obvious.** Playwright restarts the worker process after a failed test, so
 * `beforeAll` runs AGAIN for the remaining tests: fresh temp dirs, a fresh
 * config, a fresh app with no panes in it. Measured 2026-08-04, when the third
 * test failed on a locator and the fourth then failed too, on a workspace whose
 * seeded `config.json` had never been written to. Logging `configDir` in
 * `beforeAll` is what showed it, printing two different directories in one run.
 * So when a run reds more than one test here, fix the FIRST and re-run before
 * reading anything into the others.
 *
 * **Mutation measured 2026-08-04**: `FileTree.tsx`'s `toggle` changed to return
 * for a file row without calling `onOpenFile`, leaving everything else in place.
 * All 4 tests FAILED, the first at the tab bar's `README.md` with `element(s)
 * not found`, and the rest downstream of it per the paragraph above. Reverted
 * after measuring; `git diff src/renderer/FileTree.tsx` then showed only this
 * task's own change, with no residue of the mutation.
 *
 * **Reload mechanism measured 2026-08-04**: the last test's `page.reload()` is
 * what re-reads the file, and it was verified by removing it rather than
 * assumed. With the line deleted and nothing else changed, the first three
 * tests passed and the fourth FAILED at `editor-missing`, because the pane goes
 * on rendering the text it fetched when it mounted. `page.reload()` remounts the
 * renderer, `restore()` brings the sessionless pane back, and `FileView`'s mount
 * effect calls `fsRead` again, which now answers null.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-editor'

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
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-editor-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-editor-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-editor-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-editor-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-editor-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  await writeFile(join(projectCwd, 'src', 'app.ts'), 'export const answer = 42\n')
  await writeFile(join(projectCwd, 'README.md'), '# demo\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 8,
      // `slug` is required: `isProject` drops a project row without one,
      // silently, and the tree then has no project to read.
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      // Nothing seeded. Every pane and every tab row in this file is one the
      // click created, which is what separates it from `editorRestore.spec.ts`.
      panes: [],
      tabs: [],
      activeProjectId: 'p1',
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
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clicking a file opens a tab named for it', async () => {
  await page.getByTestId('tree-row-README.md').click({ timeout: 10_000 })

  // Named for the file, through the one label rule rather than around it.
  //
  // Scoped to the tab bar rather than asserted over the whole page. The plan
  // wrote this as a bare `getByText('README.md', { exact: true })`, which
  // matches three elements once the tab exists (the tree row that was just
  // clicked, the tab bar's label, and the sidebar's own row for the tab, all
  // three of which render exactly that string), and a multi-match locator is a
  // strict-mode error, not a pass. The tab bar is the one of the three that
  // only holds the string if a tab was actually opened for the file.
  await expect(page.getByTestId('tabbar').getByText('README.md', { exact: true })).toBeVisible({
    timeout: 10_000,
  })
})

// Scoped to the visible group, here and below, rather than to the page. Every
// pane in the workspace stays mounted whatever tab is on screen. A hidden
// group is `invisible`, never unmounted, so its xterm keeps its scrollback,
// which means a bare `getByTestId('editor-content')` matches one element per
// editor tab open. The plan wrote these unscoped, and the third test below
// failed on the second tab with a strict-mode violation naming both panes. The
// scope is also the stronger assertion: the file's text is in the pane the user
// is actually looking at, not merely somewhere in the DOM.
const visiblePane = (): ReturnType<Page['getByTestId']> => page.getByTestId('terminal-active')

test('the pane shows the file contents', async () => {
  await expect(visiblePane().getByTestId('editor-content')).toContainText('# demo')
})

// A second file gets a second tab, which is this slice's ruling: one tab per
// file, rather than one editor tab that swaps its contents.
test('a second file opens a second tab', async () => {
  const before = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('tree-row-src').click()
  await page.getByTestId('tree-row-src/app.ts').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(before + 1)
  await expect(visiblePane().getByTestId('editor-content')).toContainText(
    'export const answer = 42',
  )
})

// A file that is gone must say so rather than vanishing, so a moved file is
// visible rather than mysterious.
test('a file that cannot be read says so', async () => {
  await rm(join(projectCwd, 'src', 'app.ts'))
  await page.getByTestId('tree-refresh').click()
  // The tab is still open on the deleted file. Reopening it is what re-reads.
  await page.reload()
  await expect(visiblePane().getByTestId('editor-missing')).toBeVisible({ timeout: 10_000 })
})
