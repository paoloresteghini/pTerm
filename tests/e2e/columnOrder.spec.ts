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
  'issues',
  'notes',
  'todos',
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

/** A panel's own computed border widths, in px. The whole-branch review's
 *  Important finding was that a panel's container never read `side` at all,
 *  so nothing in this suite had ever asserted on a border before. */
async function borderWidthsOf(
  target: Page,
  testid: string,
): Promise<{ left: number; right: number }> {
  return target.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) throw new Error(`${id} not found`)
    const style = getComputedStyle(el)
    return { left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth) }
  }, testid)
}

/**
 * Drag the column whose handle carries `handleTestid` to the gap at
 * `dropIndex` (`column-gap-<dropIndex>`, `App.tsx`'s `gap` helper).
 *
 * The handles (`PanelHeading` / `PanelStrip` in `src/renderer/ui/Panel.tsx`)
 * are plain HTML5 `draggable` elements: their `onDragStart` / `onDragOver` /
 * `onDrop` only answer to real `DragEvent`s. Playwright's own `dragTo`
 * simulates a pointer gesture (move, down, move, up), not those events, so
 * this dispatches `dragstart`, `dragover` and `drop` explicitly, sharing one
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

test('dragging a column rightward across the terminal lands where the gap indicates, and the handle flips', async () => {
  // Continues in the same window the previous test relaunched, so the order
  // going in is that test's `expectedOrder`, not `DEFAULT_ORDER`: notes
  // first, everything else in its shipped order behind it.
  //
  // This is the direction `gap(0)` (the previous test's drop index) cannot
  // exercise: `moveColumn`'s pre-removal and post-removal index spaces only
  // agree at index 0, which is the one case that stayed green while every
  // rightward drop landed a column one slot too far right (the whole-branch
  // review's Critical finding).

  // Files starts hidden on a fresh profile; open it so its panel and
  // resizer both render, the same reason the previous test opens notes.
  await expandColumn(page, 'files')

  const orderBefore = await columnOrderOf(page)
  expect(orderBefore).toEqual([
    'notes', 'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'issues',
    'todos',
  ])

  const panelBefore = await boxOf(page, 'files-panel')
  const resizerBefore = await boxOf(page, 'resize-files')
  // Files sits left of `terminal`, so `resizerSideFor` gives it `side:
  // 'left'`, which puts the handle on the panel's RIGHT edge.
  expect(Math.abs(resizerBefore.x - (panelBefore.x + panelBefore.width))).toBeLessThan(10)
  // And its own border on the same edge (facing the terminal), none on the
  // left (facing the window frame, in this position).
  const bordersBefore = await borderWidthsOf(page, 'files-panel')
  expect(bordersBefore.right).toBeGreaterThan(0)
  expect(bordersBefore.left).toBe(0)

  // Drop on gap(6): the sliver between `skills` and `presets`, right of the
  // terminal. Pre-removal that is index 6; post-removal (files taken out of
  // index 1) it is index 5, one place left of what the highlight showed.
  await dragColumnTo(page, 'files-toggle', 6)

  const expectedOrder = [
    'notes', 'projects', 'tabs', 'terminal', 'skills', 'files', 'presets', 'prompts', 'git', 'issues',
    'todos',
  ]
  await expect.poll(() => columnOrderOf(page)).toEqual(expectedOrder)

  // The handle follows it to the opposite edge: files is now right of
  // `terminal`, so `resizerSideFor` flips to `side: 'right'`, putting the
  // handle on the panel's LEFT edge instead.
  const panelAfter = await boxOf(page, 'files-panel')
  const resizerAfter = await boxOf(page, 'resize-files')
  expect(Math.abs(resizerAfter.x - panelAfter.x)).toBeLessThan(10)
  expect(Math.abs(resizerAfter.x - resizerBefore.x)).toBeGreaterThan(50)
  // And the border flips with it: left now (facing the terminal, which is
  // behind it), none on the right. This is the whole-branch review's
  // Important finding, that the panel container never read `side` at all,
  // so an expanded column crossing the terminal drew its only border
  // against the window frame instead.
  const bordersAfter = await borderWidthsOf(page, 'files-panel')
  expect(bordersAfter.left).toBeGreaterThan(0)
  expect(bordersAfter.right).toBe(0)
})

test('a column drag does not change the terminal container width', async () => {
  // `terminal-column` (`App.tsx`'s wrapper, not `Terminal.tsx`'s own
  // `terminal` testid) so this does not need a real pty: it is the row's
  // one `flex-1 min-w-0` item regardless of whether a tab has spawned a
  // session, which is what makes it the one that absorbs whatever the
  // `gap` helper's drop targets cost the row.
  const before = await boxOf(page, 'terminal-column')

  // The regression this pins: the `column-gap-*` elements, one at each seam
  // between two columns plus one at either end of the row, used to take real
  // width the instant a drag started (`w-1 shrink-0`, no `--spacing`
  // override), and the terminal was the row's only `flex-1` item, so it
  // absorbed all of it. `Terminal.tsx`'s unconditional `ResizeObserver` then
  // fit the real tmux session to the narrowed box.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await page.getByTestId('files-toggle').dispatchEvent('dragstart', { dataTransfer })
  // Waits for the gaps to actually paint, the same reason `dragColumnTo`
  // polls `column-gap-<n>` before touching it: this is the moment the
  // pre-fix layout stole the width.
  await expect(page.getByTestId('column-gap-0')).toHaveCount(1)

  const during = await boxOf(page, 'terminal-column')
  expect(during.width).toBe(before.width)

  await page.getByTestId('files-toggle').dispatchEvent('dragend', { dataTransfer })
  await expect(page.getByTestId('column-gap-0')).toHaveCount(0)
})
