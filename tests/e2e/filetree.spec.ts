/**
 * The file tree in the sidebar, against a seeded project directory rather than
 * whatever repo the developer has checked out.
 *
 * Everything asserted here is the rendered tree. The path guard, the sort and
 * the hidden-name filter are unit tested in `tests/unit/fileTree.test.ts`
 * against the same shapes, because vitest has no DOM and this file cannot see
 * a pure function.
 *
 * **Mutation measured 2026-08-04, round 1**: adding `load(projectId, 'src')`
 * beside the root's own `load` call in `FileTree.tsx`'s launch effect, so
 * `src` is fetched without being expanded, did NOT fail `expanding a folder
 * reads it, and only then` (all 4 tests then in this file still passed, run
 * alone with `-g` and again as the whole file). Reading `FileTree.tsx`
 * explained why: the row walk recurses into a directory's children only when
 * `expanded.has(relPath)` is true, never merely because `loaded[relPath]` is
 * populated, so a pre-fetch with nothing expanding it renders nothing. That
 * test proves the FETCH is triggered by a click; on its own it does not prove
 * no directory is fetched before that click.
 *
 * **Mutation measured 2026-08-04, round 2**: `a file written after launch is
 * picked up the first time its folder is expanded`, added below to close that
 * gap, writes a new file into `src` after the app has launched, expands `src`
 * for the first time in this file, and asserts the new file's row appears.
 * The same mutation reapplied against this test: run with `-g` alone it
 * PASSED, spuriously, a timing race between the write and the mutated
 * preload's IPC round trip rather than a real pass (skipping the two tests
 * before it removes the time that round trip would otherwise have had to
 * finish). Run as the whole file it FAILED as expected, at
 * `tree-row-src/early-arrival.ts`'s `toBeVisible()`, with the other 4 tests
 * passing. The mutation was reverted after each measurement; `git diff
 * src/renderer/FileTree.tsx` was empty before continuing both times.
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
let otherCwd: string

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

  // A second project, for the switch test below: a distinct root file the
  // first project does not have, so "showing the wrong project's files"
  // and "showing no files at all" are both visibly wrong rather than only
  // provably wrong.
  otherCwd = join(projectsRoot, 'other')
  await mkdir(otherCwd, { recursive: true })
  await writeFile(join(otherCwd, 'only-in-other.txt'), '')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      // `slug` is required: `isProject` drops a project row without one,
      // silently, and the tree then has no project to read.
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [] },
        { id: 'p2', name: 'other', slug: 'other', cwd: otherCwd, presets: [] },
      ],
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

test('a file written after launch is picked up the first time its folder is expanded', async () => {
  // Written to disk after the app has already launched, so a tree that read
  // `src` eagerly at launch cannot have seen it: `toggle` only fetches when
  // `loaded[relPath]` is still undefined, so a directory pre-loaded before
  // this file existed would stay on that stale snapshot forever, since
  // nothing here ever expanded `src` before now. This must run before
  // `expanding a folder reads it, and only then`, below, or `src` is already
  // cached by the time it runs and neither implementation would refetch.
  //
  // `early-arrival.ts` rather than either of Task 5's filenames
  // (`zzz-new.md`, `zzz-nested.ts`), which this file must not collide with.
  await writeFile(join(projectCwd, 'src', 'early-arrival.ts'), '')

  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/early-arrival.ts')).toBeVisible()

  // Collapsed again: `expanding a folder reads it, and only then` (below)
  // and Task 5's own appended test both assume `src` starts closed.
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/early-arrival.ts')).toHaveCount(0)
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

test('switching projects shows the new project, not the previous one', async () => {
  // Not a race test: `fsList`'s IPC round trip is not something this suite
  // can delay, so it cannot force project A's response to land after the
  // switch to B, which is the actual bug the ref guard in `FileTree.tsx`
  // fixes. This only proves the guard has not broken ordinary,
  // non-overlapping switching.
  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('tree-row-only-in-other.txt')).toBeVisible()
  await expect(page.getByTestId('tree-row-docs')).toHaveCount(0)

  // Back to the project every other test in this file assumes is active.
  await page.getByTestId('project-p1').click()
  await expect(page.getByTestId('tree-row-docs')).toBeVisible()
  await expect(page.getByTestId('tree-row-only-in-other.txt')).toHaveCount(0)
})

test('a file is not expandable', async () => {
  await page.getByTestId('tree-row-README.md').click()
  await page.waitForTimeout(300)
  // Nothing opened under it, and nothing else changed: still the four
  // top-level rows from the first test.
  await expect(page.locator('[data-testid^="tree-row-"]')).toHaveCount(4)
})
