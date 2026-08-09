/**
 * Dragging a column into a new place in the row: the order changes, the
 * moved column's resize handle follows it to the opposite edge, and both
 * survive a relaunch.
 *
 * A fresh spec file with its own page and its own socket, copying
 * `columns.spec.ts`'s shape: project seeding, `beforeAll`/`afterAll`, and
 * `launchApp`/`killServer` from the harness. Its own `dragColumnTo` helper
 * plays the part `dragHandle` plays there, for a gesture a pointer drag
 * cannot drive.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-columnorder'

/** The row's shipped left-to-right order, `COLUMN_ORDER_DEFAULT` in
 *  `src/renderer/lib/columnOrder.ts`, before anything is dragged. */
const DEFAULT_ORDER = [
  'files',
  'projects',
  'tabs',
  'terminal',
  'skills',
  'presets',
  'prompts',
  'git',
  'notes',
]

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })

/**
 * One column's own box, read off its panel testid (e.g. `notes-panel`), not
 * its `[data-column-slot]` wrapper.
 *
 * That wrapper is `style="display: contents"` (see `App.tsx`'s render of
 * `columnOrder`), which has no box of its own: measured,
 * `getBoundingClientRect()` on it returns `{x: 0, width: 0, height: 0}`.
 * Reading geometry off it would compare two zeros and pass for the wrong
 * reason. The wrapper is for DOM order only, which is what `columnOrderOf`
 * below reads it for.
 */
async function boxOf(target: Page, testid: string): Promise<{ x: number; width: number }> {
  const box = await target.getByTestId(testid).boundingBox()
  if (!box) throw new Error(`${testid} has no box`)
  return { x: box.x, width: box.width }
}

/** The row's left-to-right order, read off `data-column-slot`: DOM order
 *  only, never geometry (see `boxOf`'s comment). */
function columnOrderOf(target: Page): Promise<string[]> {
  return target.evaluate(() =>
    [...document.querySelectorAll('[data-column-slot]')].map(
      (el) => (el as HTMLElement).dataset.columnSlot ?? '',
    ),
  )
}

/**
 * Drag the column whose handle carries `handleTestid` to the gap at
 * `dropIndex` (`column-gap-<dropIndex>`, `App.tsx`'s `gap` helper).
 *
 * The handles (`PanelHeading` / `PanelStrip` in `src/renderer/ui/Panel.tsx`)
 * are plain HTML5 `draggable` elements: their `onDragStart` / `onDragOver` /
 * `onDrop` only answer to real `DragEvent`s. Playwright's own `dragTo`
 * simulates a pointer gesture (move, down, move, up), not those events, and
 * measured against this gesture it never reordered anything. So this
 * dispatches `dragstart`, `dragover` and `drop` explicitly, sharing one
 * `DataTransfer` across all three the way a browser's own drag session
 * would, following Playwright's own documented recipe for driving HTML5
 * drag and drop through `dispatchEvent`.
 *
 * The target gap does not exist in the DOM in the same tick as `dragstart`:
 * `App.tsx` renders gaps only while its `dragging` state is non-null, and
 * that state update has not been rendered yet when `dragstart`'s handler
 * returns. Measured: querying `[data-drop-index]` immediately after
 * dispatching `dragstart` finds none. `expect(gap).toHaveCount(1)` waits for
 * the next render before touching it, which is what keeps this from flaking.
 */
async function dragColumnTo(target: Page, handleTestid: string, dropIndex: number): Promise<void> {
  const dataTransfer = await target.evaluateHandle(() => new DataTransfer())
  const handle = target.getByTestId(handleTestid)
  await handle.dispatchEvent('dragstart', { dataTransfer })

  const gap = target.getByTestId(`column-gap-${dropIndex}`)
  await expect(gap).toHaveCount(1)

  await gap.dispatchEvent('dragover', { dataTransfer })
  await gap.dispatchEvent('drop', { dataTransfer })
  await handle.dispatchEvent('dragend', { dataTransfer })
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-columnorder-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-columnorder-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-columnorder-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-columnorder-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-columnorder-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  await mkdir(alphaCwd, { recursive: true })
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'id-alpha', name: 'alpha', slug: 'alpha', cwd: alphaCwd, presets: [] }],
      tabs: [],
      activeProjectId: 'id-alpha',
      activeTabId: null,
    }),
  )

  app = await launch()
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dragging notes across the terminal moves it, flips its handle, and both survive a relaunch', async () => {
  // Notes starts collapsed on a fresh profile; its box (and the resizer,
  // which the collapsed strip does not render at all) only exist once it is
  // open, and the drag handle works from either state.
  await expandColumn(page, 'notes')

  const orderBefore = await columnOrderOf(page)
  expect(orderBefore).toEqual(DEFAULT_ORDER)

  const panelBefore = await boxOf(page, 'notes-panel')
  const resizerBefore = await boxOf(page, 'resize-notes')
  // Notes sits after `terminal` in the default order, so `resizerSideFor`
  // gives it `side: 'right'`, which puts the handle on the panel's LEFT
  // edge (the edge nearest the terminal, per `ColumnResizer`'s doc comment).
  expect(Math.abs(resizerBefore.x - panelBefore.x)).toBeLessThan(10)

  // 1. The order changes: dragged across the terminal, to the very front.
  await dragColumnTo(page, 'notes-toggle', 0)

  const expectedOrder = ['notes', ...DEFAULT_ORDER.filter((slot) => slot !== 'notes')]
  await expect.poll(() => columnOrderOf(page)).toEqual(expectedOrder)

  // 2. The handle follows it. Notes is now first, ahead of `terminal`, so
  // `resizerSideFor` flips to `side: 'left'`, which puts the handle on the
  // panel's RIGHT edge instead, the opposite edge from before the drag.
  //
  // Deliberately checked BEFORE the persistence assertions below: a mutation
  // that breaks only persistence (see the sabotage note in the report) must
  // still leave assertions 1 and 2 passing, which only holds if nothing
  // between here and there can throw first.
  const panelAfter = await boxOf(page, 'notes-panel')
  const resizerAfter = await boxOf(page, 'resize-notes')
  expect(panelAfter.x).toBe(0)
  expect(Math.abs(resizerAfter.x - (panelAfter.x + panelAfter.width))).toBeLessThan(10)
  // Not a coincidence: the handle is nowhere near the edge it started on.
  expect(Math.abs(resizerAfter.x - panelAfter.x)).toBeGreaterThan(50)

  // 3. It survives a relaunch, order and handle side both.

  // Persisted immediately, not only on relaunch: `moveColumnTo` writes
  // `pterm:columnOrder` inside the same state update that moves it.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('pterm:columnOrder')))
    .toBe(JSON.stringify(expectedOrder))

  await app.close()
  app = await launch()
  page = await app.firstWindow()

  await expect.poll(() => columnOrderOf(page)).toEqual(expectedOrder)
  // `notesCollapsed` persists independently of `columnOrder` (its own
  // `pterm:notesCollapsed` key), and `expandColumn` opened it above, so the
  // panel is already open here rather than needing a second expand.
  await expect(page.getByTestId('notes-panel')).toBeVisible()
  const panelRestored = await boxOf(page, 'notes-panel')
  const resizerRestored = await boxOf(page, 'resize-notes')
  expect(panelRestored.x).toBe(0)
  expect(Math.abs(resizerRestored.x - (panelRestored.x + panelRestored.width))).toBeLessThan(10)
})
