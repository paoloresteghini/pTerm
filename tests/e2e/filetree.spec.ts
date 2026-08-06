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
 *
 * **Mutation measured 2026-08-04, round 3**: deleting `reload`'s loop over
 * `expanded`, leaving only its root `load`, so a refresh re-reads the root
 * but never an already-open folder. Against `refresh re-reads the root and
 * every open folder` as first written, without priming `src` before the
 * writes below, this PASSED at 7/7 despite the mutation: `switching
 * projects...`, above, is the last thing before this test to change
 * `projectId`, and `FileTree.tsx`'s launch effect calls `setLoaded({})` on
 * every such change, clearing `src`'s cache; nothing after that switch
 * re-expands it, so this test's own first click on `src` was its first
 * expand since the reset, a live fetch landing after both writes regardless
 * of `reload`. Priming `src` (expand it, collapse it) before either write,
 * as the test now does, closed that gap: run as the whole file, the mutation
 * FAILED at `tree-row-src/zzz-nested.ts`'s `toBeVisible()` and NOT at
 * `tree-row-zzz-new.md`, which passed, with the other 6 tests passing. The
 * mutation was reverted after measuring; `git diff src/renderer/FileTree.tsx`
 * was empty before continuing.
 *
 * **Mutation measured 2026-08-04, round 4**: `reload` was changed to evict
 * `loaded` keys that are neither `''` nor in `expanded` before it fetches, so
 * a folder that was expanded, then collapsed, does not keep serving a stale
 * cached listing forever. Re-running round 3's mutation (deleting the loop
 * over `expanded`) against the changed `reload`, as the whole file, still
 * FAILED at `tree-row-src/zzz-nested.ts`'s `toBeVisible()` and NOT at
 * `tree-row-zzz-new.md` — the split survives the eviction change, because at
 * the moment `refresh re-reads...` clicks the refresh button, `src` is
 * expanded, so eviction leaves its cache alone and the loop deletion is what
 * the test still isolates. Separately, a scratch reproduction of the
 * unfixed bug (expand `src`, collapse it, write a file into `src` and one at
 * the root, click refresh while `src` is collapsed, then expand it) showed
 * the pre-fix code needing a SECOND refresh to show the nested file, and the
 * fixed code showing it on the first expand after one refresh. Reverted
 * after measuring; `git diff src/renderer/FileTree.tsx` was empty before
 * continuing.
 *
 * **Mutation measured 2026-08-04, round 5**: deleting `!entry.dir ||` from
 * `toggle`'s guard in `FileTree.tsx`, so a file (not just a directory)
 * reaches `expanded`. `a file is not expandable`'s row-count assertion alone
 * did not catch this: clicking a file still renders no new rows, because its
 * `readdir` throws ENOTDIR and `listDir` reports that as `[]`. Run as the
 * whole file, this mutation FAILED the added `localStorage` assertion in
 * that test and no other. Reverted after measuring; `git diff
 * src/renderer/FileTree.tsx` was empty before continuing.
 *
 * **Mutation measured 2026-08-04, round 6**: `readExpanded(projectId)` in the
 * launch effect replaced with `new Set<string>()`, and the `writeExpanded`
 * call in `toggle` deleted, together — the same double mutation the review
 * that produced this fix measured. Run as the whole file, twice, this FAILED
 * `switching projects shows the new project, not the previous one` both
 * times, at the `tree-row-src/app.ts` visibility assertion made after
 * switching back to `p1` without re-clicking `tree-row-src`. Reverted after
 * measuring; `git diff src/renderer/FileTree.tsx` was empty before
 * continuing.
 *
 * **Mutation measured 2026-08-04, round 7**: deleting the whole eviction
 * block round 4 added to `reload` (the `setLoaded` call dropping keys that
 * are neither `''` nor in `expanded`), leaving `reload` as only the two
 * `load` calls below it. Run as the whole file, this FAILED the new
 * `refresh drops a collapsed folder's stale cache` at its
 * `tree-row-src/zzz-late.ts` `toBeVisible()` and no other, with the other 7
 * tests passing. Reverted after measuring; `git diff
 * src/renderer/FileTree.tsx` was empty before continuing.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

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
  // The tree has its own column now, collapsed on a fresh profile. Opened
  // once for the file, which shares one page across every test.
  await expandColumn(page, 'files')
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
  // Expanded before the switch, so returning to p1 can prove the expanded
  // set actually came back with it. `tests/unit/treeState.test.ts` proves
  // `readExpanded`/`writeExpanded` work in isolation; nothing before this
  // proved `FileTree.tsx` calls either one.
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/app.ts')).toBeVisible()

  // Not a race test: `fsList`'s IPC round trip is not something this suite
  // can delay, so it cannot force project A's response to land after the
  // switch to B, which is the actual bug the ref guard in `FileTree.tsx`
  // fixes. This only proves the guard has not broken ordinary,
  // non-overlapping switching.
  await page.getByTestId('project-p2').click()
  await expect(page.getByTestId('tree-row-only-in-other.txt')).toBeVisible()
  await expect(page.getByTestId('tree-row-docs')).toHaveCount(0)

  // Back to the project every other test in this file assumes is active.
  // `src/app.ts` must be visible here WITHOUT clicking `tree-row-src` again:
  // that is what tells `readExpanded` restored the set apart from `toggle`
  // simply still working.
  await page.getByTestId('project-p1').click()
  await expect(page.getByTestId('tree-row-docs')).toBeVisible()
  await expect(page.getByTestId('tree-row-only-in-other.txt')).toHaveCount(0)
  await expect(page.getByTestId('tree-row-src/app.ts')).toBeVisible()

  // Collapsed again: the tests below assume `src` starts closed.
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/app.ts')).toHaveCount(0)
})

test('a file is not expandable', async () => {
  await page.getByTestId('tree-row-README.md').click()
  await page.waitForTimeout(300)
  // Nothing opened under it, and nothing else changed: still the four
  // top-level rows from the first test.
  await expect(page.locator('[data-testid^="tree-row-"]')).toHaveCount(4)
  // The row count alone does not discriminate a missing guard from a
  // present one: a file that gets past `toggle`'s `entry.dir` check still
  // renders no children, because `README.md`'s own `readdir` throws
  // ENOTDIR and `listDir` reports that as an empty list. What the guard
  // actually controls is whether the click ever reaches `expanded` at all,
  // so assert that directly.
  const raw = await page.evaluate(() => localStorage.getItem('prcli:treeExpanded:p1'))
  expect(raw === null ? [] : (JSON.parse(raw) as string[])).not.toContain('README.md')
})

test('refresh re-reads the root and every open folder', async () => {
  // Primed and closed before either file is written, so `src`'s directory
  // listing is already cached by the time the write below happens. Without
  // this, `switching projects...` above is the last thing to change
  // `projectId`, and that effect's `setLoaded({})` clears the cache on every
  // switch; nothing after it re-expands `src`, so the click further down
  // would be `src`'s FIRST expand since that reset and would fetch live,
  // already after the write, passing this test even with `reload`'s loop
  // over `expanded` deleted. Measured 2026-08-04, see this file's header.
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/app.ts')).toBeVisible()
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/app.ts')).toHaveCount(0)

  // Written to disk behind the app's back, which is the case refresh exists
  // for: another session, or a Claude pane, changing the tree under it.
  await writeFile(join(projectCwd, 'zzz-new.md'), '#')
  await writeFile(join(projectCwd, 'src', 'zzz-nested.ts'), '')

  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/app.ts')).toBeVisible()

  // Not there yet: the tree has no watcher, and this asserts that as much as
  // it asserts the refresh. Without it, a refresh button wired to nothing
  // would pass the rest of this test on a tree that happened to re-render.
  await expect(page.getByTestId('tree-row-zzz-new.md')).toHaveCount(0)
  // Nor the nested file: `src` was primed and closed above, before the
  // write, so this expand is reading the stale cache, not a fresh fetch.
  await expect(page.getByTestId('tree-row-src/zzz-nested.ts')).toHaveCount(0)

  await page.getByTestId('tree-refresh').click()

  await expect(page.getByTestId('tree-row-zzz-new.md')).toBeVisible()
  // The open folder too, not just the root. A refresh that re-read only the
  // root would satisfy the line above.
  await expect(page.getByTestId('tree-row-src/zzz-nested.ts')).toBeVisible()
})

test('refresh drops a collapsed folder’s stale cache', async () => {
  // `src` is left expanded by the test above. Collapse it, change it on disk,
  // refresh while it is closed, then open it: the fresh listing must be what
  // opens, not whatever `loaded` still held from before the refresh.
  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/app.ts')).toHaveCount(0)

  await writeFile(join(projectCwd, 'src', 'zzz-late.ts'), '')

  await page.getByTestId('tree-refresh').click()
  // No visible effect on a closed folder to wait for: the root's own re-read
  // landing is not a signal that the collapsed folder's eviction has been
  // applied, so this gives the refresh time to finish before the next click.
  await page.waitForTimeout(300)

  await page.getByTestId('tree-row-src').click()
  await expect(page.getByTestId('tree-row-src/zzz-late.ts')).toBeVisible()
})
