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
 * case `restoreWorkspace` cannot answer on its own — it starts from live tmux,
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
 * and the call log says `element(s) not found` rather than `hidden` — with the
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
 * added to make it fail — that is Paolo's call, not this file's.
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

/** The pane row as it stands on disk right now, or undefined if it has gone. */
async function savedPane(): Promise<{ id: string; filePath?: string } | undefined> {
  const written = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as {
    panes: { id: string; filePath?: string }[]
  }
  return written.panes.find((row) => row.id === 'e1')
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
      ],
      // The real `TabRow`: `kids`, `ratio` and the axis under `layout`, with
      // `activePaneId` beside them. A flat row is not a lenient spelling of
      // this one — `normaliseLayout` answers null for a missing `layout`, and
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
  await expect.poll(async () => (await savedPane())?.filePath, { timeout: 10_000 }).toBe(seededFile)

  const written = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as {
    tabs: { id: string; layout: { kids: string[] } }[]
  }
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

  // The half no unit test reaches: the pane has to survive a whole second
  // reconcile, reading the file the first one wrote rather than the one this
  // spec seeded.
  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId('pane-e1')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await savedPane())?.filePath, { timeout: 10_000 }).toBe(seededFile)
  await second.close()
})
