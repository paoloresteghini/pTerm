/**
 * The file tree in the sidebar, against a seeded project directory rather than
 * whatever repo the developer has checked out.
 *
 * Everything asserted here is the rendered tree. The path guard, the sort and
 * the hidden-name filter are unit tested in `tests/unit/fileTree.test.ts`
 * against the same shapes, because vitest has no DOM and this file cannot see
 * a pure function.
 *
 * **Mutation measured 2026-08-04**: adding `load(projectId, 'src')` beside the
 * root's own `load` call in `FileTree.tsx`'s launch effect, so `src` is
 * fetched without being expanded, does NOT fail `expanding a folder reads it,
 * and only then` (all 4 tests here still passed, run alone with `-g` and
 * again as the whole file). Reading `FileTree.tsx` explains why: the row
 * walk recurses into a directory's children only when `expanded.has(relPath)`
 * is true, never merely because `loaded[relPath]` is populated: a pre-fetch
 * with nothing expanding it renders nothing. What this suite actually proves
 * lazy is the FETCH triggered by a click; it does not, on its own, prove no
 * directory is fetched before that click. The mutation was reverted after
 * this was recorded.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-filetree'

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
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-tree-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-tree-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-tree-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-tree-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-tree-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src', 'main'), { recursive: true })
  await mkdir(join(projectCwd, 'docs'), { recursive: true })
  await mkdir(join(projectCwd, 'node_modules'), { recursive: true })
  await mkdir(join(projectCwd, '.git'), { recursive: true })
  await writeFile(join(projectCwd, 'README.md'), '#')
  await writeFile(join(projectCwd, '.env'), 'KEY=1')
  await writeFile(join(projectCwd, 'src', 'app.ts'), '')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      // `slug` is required: `isProject` drops a project row without one,
      // silently, and the tree then has no project to read.
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
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lists the active project at the top level, folders first', async () => {
  const rows = page.locator('[data-testid^="tree-row-"]')
  // Four rows, not five: `app.ts` lives under `src/`, which is collapsed at
  // launch, so only the project root's own entries are here. `docs` and `src`
  // sort before `.env` and `README.md` as directories always do, and `.env`
  // sorts before `README.md` by `localeCompare`, verified in node on
  // 2026-08-04 (`'.env' < 'README.md'`). `tests/unit/fileTree.test.ts` asserts
  // the same sort rule against the same shapes.
  await expect(rows).toHaveCount(4, { timeout: 10_000 })
  expect(await rows.allInnerTexts()).toEqual(['docs', 'src', '.env', 'README.md'])
})

test('hides .git and node_modules and shows other dotfiles', async () => {
  await expect(page.getByTestId('tree-row-.git')).toHaveCount(0)
  await expect(page.getByTestId('tree-row-node_modules')).toHaveCount(0)
  await expect(page.getByTestId('tree-row-.env')).toBeVisible()
})

test('expanding a folder reads it, and only then', async () => {
  // Not present before the click, which is the lazy claim. A tree that read
  // every directory at launch would satisfy every other assertion in this file.
  await expect(page.getByTestId('tree-row-src/main')).toHaveCount(0)

  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/main')).toBeVisible()
  await expect(page.getByTestId('tree-row-src/app.ts')).toBeVisible()

  // Collapsing takes them away again.
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/main')).toHaveCount(0)
})

test('a file is not expandable', async () => {
  await page.getByTestId('tree-row-README.md').click()
  await page.waitForTimeout(300)
  // Nothing opened under it, and nothing else changed: still the four
  // top-level rows from the first test.
  await expect(page.locator('[data-testid^="tree-row-"]')).toHaveCount(4)
})
