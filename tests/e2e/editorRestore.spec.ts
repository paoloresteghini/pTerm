/**
 * A pane with no tmux session, across a relaunch.
 *
 * This file exists because the restore path fails silently: `b397216` added a
 * pane field that was correct on screen, correct on disk, and gone after
 * relaunch, with nothing thrown. Every assertion here is about what came back
 * from disk, and the pane is seeded into config rather than created through
 * the UI, so this runs before any UI can make one.
 *
 * The seeded pane is the whole of the config: no terminal, no tmux session, and
 * so nothing on this file's socket for `findOrphanTabs` to find. That is the
 * case `restoreWorkspace` cannot answer on its own. It starts from live tmux,
 * and live tmux has nothing to say about this pane.
 *
 * No relaunch pattern was invented for this. `launch.spec.ts`
 * (`reattaches the same session with scrollback after relaunch`),
 * `projects.spec.ts`, `status.spec.ts` and `splits.spec.ts` all close an app
 * and call the same `launch()` again against the same `configDir`, and the
 * third test below is that, unchanged.
 *
 * **Measured 2026-08-04, deleting the `mergeSessionlessPanes` call from
 * `restore.ts`: 3 failed.** All three at their `toBeVisible('pane-e1')` line,
 * and the call log says `element(s) not found` rather than `hidden`: with the
 * merge gone the pane is not in the reply at all, so no box is built for it.
 * The distinction is worth keeping, because the same three assertions failed
 * once during this task's own development with the element PRESENT and hidden:
 * that was the merge running but placed after `describeProjects`, so the
 * project's `activeTabId` resolved to null and the group holding the pane was
 * never made visible. Same red line, different defect.
 *
 * **Measured 2026-08-04, deleting `if (row.filePath) next.filePath =
 * row.filePath` from `savedFields.ts`: 3 passed. Nothing failed, and that is a
 * finding rather than a formality.** `filePath` does not reach the write
 * through `attachSavedFields` today: `mergeSessionlessPanes` puts the SAVED
 * pane row itself into `panes`, file path and all, so there is nothing for that
 * map to reattach. The line is kept as defence for a future path that hands
 * restore a manager-built editor pane (see its own docstring), and no test was
 * added to make it fail. That is Paolo's call, not this file's.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-editor-restore'

let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string
let seededFile: string

// Through the shared harness like every other launch in this suite, so all
// five path overrides are set by construction rather than by another copy of
// one env block that could drift away from the other specs'.
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

/** Config as it stands on disk right now. */
async function readConfig(): Promise<{
  panes: { id: string; filePath?: string }[]
  tabs: { id: string; layout: { kids: string[] } }[]
}> {
  return JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
}

/** The pane row as it stands on disk right now, or undefined if it has gone. */
async function savedPane(): Promise<{ id: string; filePath?: string } | undefined> {
  return (await readConfig()).panes.find((row) => row.id === 'e1')
}

/**
 * A pane row for a tmux session that does not exist, written between two
 * launches so the NEXT restore has something to remove.
 *
 * The point is falsifiability, not the sentinel itself. Asserting the editor
 * pane is on disk after a relaunch cannot fail on its own: the value is already
 * in the file from the previous run, so the assertion passes whether the second
 * launch wrote anything or not. Restore prunes a saved terminal whose session is
 * gone, so this row is present before the relaunch and absent after it if and
 * only if the second reconcile actually wrote the file.
 */
async function seedDeadTerminal(): Promise<void> {
  const config = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  config.panes.push({
    id: 'sentinel',
    projectSlug: 'demo',
    cwd: projectCwd,
    type: 'shell',
    // Never created on this socket, so no restore can find it live.
    tmuxSession: 'prcli-demo-sentinel',
  })
  await writeFile(join(configDir, 'config.json'), JSON.stringify(config), 'utf8')
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-ed-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-ed-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-ed-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-ed-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-ed-claude-'))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  seededFile = join(projectCwd, 'src', 'seeded.ts')
  await writeFile(seededFile, 'const seeded = 1\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 8,
      // `slug` is required: `isProject` drops a project row without one,
      // silently, and there is then no project for the pane to belong to.
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: 'e1' },
      ],
      panes: [
        { id: 'e1', projectSlug: 'demo', cwd: projectCwd, type: 'editor', filePath: seededFile },
        // See `seedDeadTerminal`. Present from the first launch so the disk
        // assertions below can tell "restore wrote and kept the pane" from
        // "restore never wrote and these are the bytes this file seeded".
        { id: 'sentinel', projectSlug: 'demo', cwd: projectCwd, type: 'shell', tmuxSession: 'prcli-demo-sentinel' },
      ],
      // The real `TabRow`: `kids`, `ratio` and the axis under `layout`, with
      // `activePaneId` beside them. A flat row is not a lenient spelling of
      // this one: `normaliseLayout` answers null for a missing `layout`, and
      // `store.read()` then drops the whole row, taking the only tab that
      // holds the pane with it.
      tabs: [
        { id: 'tabE', groupId: 'tabE', activePaneId: 'e1', layout: { dir: 'row', ratio: [1], kids: ['e1'] } },
      ],
      activeProjectId: 'p1',
    }),
    'utf8',
  )
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a seeded editor pane is on screen at launch', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })
  await app.close()
})

// The assertion this file exists for. Not "a pane is there" but "the pane and
// its file path are still in the file restore just wrote".
test('restore does not write the editor pane away', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })

  // Polled, not read once: the render above proves the reply held the pane,
  // and the write that could drop it happens in the same reconcile but is not
  // what the screen is waiting on.
  //
  // The sentinel is what makes this an assertion about the write rather than
  // about the seed. Measured 2026-08-04: with `store.write` skipped, the
  // `filePath` half alone still passed, because the value it reads is the one
  // this file wrote in `beforeEach`.
  await expect
    .poll(
      async () => {
        const config = await readConfig()
        return {
          sentinel: config.panes.some((row) => row.id === 'sentinel'),
          filePath: config.panes.find((row) => row.id === 'e1')?.filePath,
        }
      },
      { timeout: 10_000 },
    )
    .toEqual({ sentinel: false, filePath: seededFile })

  const written = await readConfig()
  const tab = written.tabs.find((row) => row.id === 'tabE')
  expect(tab).toBeDefined()
  // The tab, not merely a tab: a pane no tab holds cannot be reached, focused
  // or closed, so the row surviving is half of the pane surviving.
  expect(tab?.layout.kids).toEqual(['e1'])
  await app.close()
})

test('the editor pane comes back after a relaunch', async () => {
  const first = await launch()
  const opened = await first.firstWindow()
  await expect(opened.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await savedPane())?.filePath, { timeout: 10_000 }).toBe(seededFile)
  await first.close()

  // See `seedDeadTerminal`: without it the disk assertion below reads the first
  // run's bytes and passes whether or not the second run wrote at all.
  await seedDeadTerminal()

  // The half no unit test reaches: the pane has to survive a whole second
  // reconcile, reading the file the first one wrote rather than the one this
  // spec seeded.
  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })

  // One poll over one read of the file, so the two facts are asserted about the
  // same bytes: the sentinel gone is what proves this reconcile wrote, and the
  // file path present is what the test is for.
  await expect
    .poll(
      async () => {
        const config = await readConfig()
        return {
          sentinel: config.panes.some((row) => row.id === 'sentinel'),
          filePath: config.panes.find((row) => row.id === 'e1')?.filePath,
        }
      },
      { timeout: 10_000 },
    )
    .toEqual({ sentinel: false, filePath: seededFile })
  await second.close()
})

// The spec's own acceptance test for this slice: open a file, edit, save,
// relaunch, and find the edit. Note what it does NOT assert: that the pane
// was still dirty. Dirtiness is renderer state and is deliberately not
// persisted, so a pane that was dirty at quit reopens clean against what is
// on disk, which is what the next test pins.
test('an edit saved before a relaunch is there afterwards', async () => {
  const first = await launch()
  const opened = await first.firstWindow()
  await expect(opened.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })
  const content = opened.getByTestId('editor-content')
  await content.locator('.cm-content').click()
  await opened.keyboard.type('// edited\n')
  await opened.keyboard.press('Meta+s')
  await expect(opened.getByTestId('editor-dirty-e1')).toHaveCount(0)
  await first.close()

  // `app.close()` here, and everywhere else this file relaunches: a real
  // quit with unsaved work is a case this slice does not handle. Nothing
  // prompts on window close, only on pane close (Task 5). That gap is known
  // and deliberately out of scope for this task.
  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId('editor-content')).toContainText('// edited', {
    timeout: 10_000,
  })
  await second.close()
})

test('an unsaved edit is gone after a relaunch, and the tab is clean', async () => {
  const first = await launch()
  const opened = await first.firstWindow()
  await expect(opened.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })
  const content = opened.getByTestId('editor-content')
  await content.locator('.cm-content').click()
  await opened.keyboard.type('// not saved')
  await expect(opened.getByTestId('editor-dirty-e1')).toBeAttached()
  await first.close()

  const second = await launch()
  const reopened = await second.firstWindow()
  // The load, anchored POSITIVELY before either negative below is read, and it
  // is the whole point of this line. `editor-content` is the host div: it is on
  // screen from the first paint, before `fsRead` resolves and before CodeMirror
  // builds anything under it, and it has a non-zero box, so a `toBeVisible`
  // here is satisfied by an EMPTY editor. Both assertions below are negatives,
  // and both pass against an empty editor too. Anchoring on the seeded bytes,
  // which are on disk and unchanged, is what makes the two of them wait for a
  // document to actually be there before they say anything about it.
  await expect(reopened.getByTestId('editor-content')).toContainText('const seeded = 1', {
    timeout: 10_000,
  })
  await expect(reopened.getByTestId('editor-content')).not.toContainText('// not saved')
  await expect(reopened.getByTestId('editor-dirty-e1')).toHaveCount(0)
  await second.close()
})
