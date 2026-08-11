/**
 * The drag-a-tab-onto-another gesture, end to end, on the `pterm-e2e-dragsplit`
 * socket.
 *
 * Four tests: dragging one row onto another brackets them as one split, two
 * tmux sessions and all, without closing and respawning either pane; a row
 * dropped on itself is refused before anything is dropped; a pane dragged
 * onto its own sibling, already in the same split, is refused the same way;
 * and the identical merge again, driven through the tab BAR rather than the
 * column, which is the surface a user actually meets first (the column
 * starts hidden and needs the View menu to reach at all).
 *
 * Playwright's own `dragTo` drives pointer events, and Electron does not
 * synthesise those into HTML5 drag events, so every gesture here is a direct
 * `DragEvent` dispatch instead: `beginDrag` fires `dragstart` on the source and
 * `dragover` on the target, `dropOn` fires `drop` on the target and `dragend`
 * on the source, and both share the one `DataTransfer` `beginDrag` stashes on
 * the source element: a fresh `DataTransfer` per call would leave `drop`'s
 * `event.dataTransfer.getData` reading nothing, since only the object that was
 * actually present at `dragstart` carries the MIME payload `usePaneDragDrop`
 * wrote to it.
 *
 * The two refusal tests do not stop at asserting the drop did nothing. A join
 * `canJoin` should refuse is ALSO refused independently by
 * `SessionManager.joinTab`'s own `moving.tabId === target.tabId` guard
 * (`src/main/sessions/manager.ts:993-995`), so a dropped-and-swallowed IPC
 * call leaves the same on-screen state whether `canJoin` caught it or main did:
 * the bracket and session-count assertions cannot tell the two apart. What
 * can is the HOVER: `canJoin` gates `onDragOver` before a drop is ever sent
 * (`usePaneDragDrop.ts`'s `if (!dragged || !canJoin(dragged, paneId)) return`),
 * and that gate is the renderer's alone, main is never asked. So both
 * refusal tests read `data-over` right after `beginDrag`, before `dropOn` runs
 * at all, which is the one signal a broken `canJoin` cannot hide behind main's
 * own defense in depth. See the sabotage note below for the two mutations this
 * was measured against.
 *
 * **Measured 2026-08-10**, `canJoin` in `src/renderer/App.tsx` forced to
 * `return true` unconditionally: both refusal tests fail, each on its
 * `data-over` assertion and not on anything after it: `a tab dropped on
 * itself is refused` reads `data-over="true"` on the pane it hovered over
 * itself, and `a pane is refused as a drop target inside its own tab` reads
 * the same on the sibling's target row. Both happy-path tests, the column's
 * and the bar's, stay green, since they already wanted `canJoin` to accept
 * that pair. 2 failed, 2 passed.
 *
 * **Measured the same day**, `canJoin` forced to `return false`
 * unconditionally: both happy-path tests fail at their own `data-over` read,
 * before the drop is ever sent, and both refusal tests stay green: they
 * wanted a refusal and got one, for the wrong reason but the right shape. 2
 * failed, 2 passed. Between the two mutations every test in this file goes
 * red at least once, and none goes red at the same assertion `canJoin`
 * returning its correct, unmutated value would also fail.
 *
 * **What this file does NOT see:**
 *
 * - **a refusal driven through the bar.** The fourth test only drives the
 *   bar's happy path; the two refusal shapes (self, same-tab sibling) are
 *   only exercised on the column. Both surfaces call the same `canJoin`, so a
 *   refusal bug would show up on the column regardless of which surface a
 *   user actually dragged on, which is the reasoning for not doubling every
 *   case across both surfaces;
 * - **a three-or-more-pane tab as either end of the drag.** Every join here
 *   starts from a single pane or a two-pane split; nothing drags a third pane
 *   onto an existing pair, so `carveRatio`'s share arithmetic for that case is
 *   untouched;
 * - **cross-project refusal.** `canJoin`'s `fromPane.projectSlug !==
 *   toPane.projectSlug` branch needs two projects, and every test here seeds
 *   one;
 * - **the visual highlight itself**, as distinct from the `data-over`
 *   attribute driving it (a Tailwind ring class on the column, an inset
 *   `boxShadow` on the bar). The tests read the attribute; a screenshot would
 *   have to be eyeballed to confirm either one actually paints;
 * - **what the moved pane's tmux window looks like mid-move**, or any of
 *   `joinTab`'s own tmux sequence: that is `SessionManager.joinTab`'s own
 *   test in `tests/integration/`, not this file. What this file can see is the
 *   session COUNT before and after, which is what tells a join from a
 *   close-and-respawn; it cannot see the window that carried the pane across.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames } from './harness'

const SOCKET = 'pterm-e2e-dragsplit'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

// Same shared-harness construction `splits.spec.ts` uses, on this file's own
// socket, so the two never share a tmux server.
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

/**
 * Write a config holding one project, selected. Copied from `splits.spec.ts`'s
 * helper of the same name and purpose: `choose-folder` opens a native dialog
 * Playwright cannot drive, so the project has to exist on disk before launch
 * rather than be added through the UI.
 */
async function seedProject(slug: string, name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `pterm-proj-${slug}-`))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: `id-${slug}`, name, slug, cwd, presets: [], activeTabId: null }],
      activeProjectId: `id-${slug}`,
      tabs: [],
    }),
    'utf8',
  )
  return cwd
}

/**
 * Fire a menu item by id, the way a click on the real menu bar would.
 * Copied from `menuColumns.spec.ts`'s helper of the same name and purpose:
 * Playwright cannot reach the macOS menu bar, so the View menu's items are
 * driven through the main process instead.
 */
async function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click()
  }, id)
}

/**
 * Opens the tabs column, and confirms the panel is actually there afterwards
 * rather than assuming the click worked.
 *
 * Three states, not two (`Panel.tsx`'s own doc comment): every column starts
 * HIDDEN, `hiddenColumns.tabs`'s stored default (`App.tsx:182`), which
 * renders NOTHING: no strip, no heading, nothing this file could click. The
 * View menu's `toggle-tabs` item is the only way in, since there is no
 * keyboard shortcut for this one column (`⌥⌘T` is free, but nothing in
 * `App.tsx`'s keydown map binds it: `toggleTabs`'s own comment says so,
 * "unlike its siblings only the menu ever calls it").
 *
 * One click is the whole gesture, not two. `setColumnHidden`'s own doc
 * comment says why: "Showing also un-collapses: a column asked for from the
 * menu should arrive open rather than as a strip the user has to click
 * again" (`App.tsx:299-305`). The same one call that clears `hiddenColumns`
 * also clears the per-column collapsed flag, so `tabs-toggle`, the collapsed
 * strip, is never on screen at all on the way to `tabs-panel`. Measured: an
 * earlier version of this helper waited for `tabs-toggle` first, on the
 * assumption every column reopens through its strip, and it never appeared.
 * `menuColumns.spec.ts`'s own `toggle-git` test goes straight from nothing to
 * `git-panel` for the identical reason, one call site over.
 */
async function ensureTabsColumnOpen(app: ElectronApplication, window: Page): Promise<void> {
  await expect(window.getByTestId('titlebar')).toBeVisible()
  if ((await window.getByTestId('tabs-panel').count()) > 0) return
  await clickMenuItem(app, 'toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible({ timeout: 20_000 })
}

/** The tabs column's own row prefix (`TabsPanel.tsx`): `vpane-<paneId>`. */
const COLUMN_PREFIX = 'vpane-'

/**
 * The tab BAR's own row prefix (`TabBar.tsx`): `tab-<paneId>`. Not a new
 * testid, this is the one 27-plus other e2e specs already count tabs with
 * (`[data-testid^="tab-"]`, see `tabs.spec.ts:129` for one), read here rather
 * than added.
 */
const BAR_PREFIX = 'tab-'

/**
 * The pane ids of the tabs column, in the order the column draws them.
 * The column names every row `vpane-<paneId>` (`TabsPanel.tsx`).
 */
async function columnPaneIds(window: Page): Promise<string[]> {
  const rows = window.locator(`[data-testid^="${COLUMN_PREFIX}"]`)
  await expect(rows.first()).toBeVisible()
  return (
    await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid ?? ''))
  ).map((id) => id.replace(COLUMN_PREFIX, ''))
}

/** The pane ids of the tab BAR, in the order the bar draws them. */
async function barTabIds(window: Page): Promise<string[]> {
  const rows = window.locator(`[data-testid^="${BAR_PREFIX}"]`)
  await expect(rows.first()).toBeVisible()
  return (
    await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid ?? ''))
  ).map((id) => id.replace(BAR_PREFIX, ''))
}

/**
 * Starts one drag gesture: `dragstart` on `from`'s row, then `dragover` on
 * `to`'s. The `DataTransfer` is stashed on the source element itself, rather
 * than on `window`, so `dropOn` below can find the SAME object
 * `usePaneDragDrop` wrote the pane id into: a fresh one would carry nothing
 * on `drop`.
 *
 * Two `evaluate` calls, not one, and not for the reason the drop is a third.
 * `usePaneDragDrop`'s `dragged`, the id `onDragOver` reads `canJoin` against,
 * is REACT STATE, set by `setDragged` inside the `dragstart` handler. A
 * dispatch and its handler run synchronously, but the state write does not
 * become visible to the NEXT handler's closure until React commits it, and
 * two `dispatchEvent` calls made back to back inside one `evaluate` run in
 * the same synchronous stretch React never gets a turn inside. **Measured
 * 2026-08-10**: `dragstart` and `dragover` dispatched together, in one
 * `evaluate`, read `dragged` as `null` inside `onDragOver` (confirmed by a
 * temporary `console.log` in the hook): the hover was refused on every
 * pair, including ones `canJoin` should accept, which would have made every
 * `data-over` assertion in this file pass for the same wrong reason
 * regardless of what `canJoin` actually returned. Splitting the two
 * dispatches across separate `evaluate` calls, each one a real round trip
 * through Playwright and well past React's commit, fixed it: the same
 * `console.log` then read the correct dragged id and the correct `canJoin`
 * boolean. `drop` and `dragend` stay together in `dropOn` below because
 * `onDrop`'s own guard does not depend on this state at all: `dataTransfer`
 * carries the id there, read straight off the DOM API, not out of a
 * component's closure.
 *
 * `prefix` picks the surface: `COLUMN_PREFIX` (the default) for the tabs
 * column's `vpane-` rows, `BAR_PREFIX` for the tab bar's `tab-` rows.
 * `TabsPanel.tsx` and `TabBar.tsx` each call `usePaneDragDrop(canJoin,
 * onJoin)` themselves, but with the SAME `canJoin` and `joinPanes` App.tsx
 * passes both of them, and both surfaces read the hook's `over` back onto
 * their own row as the identical `data-over={drag.over === id || undefined}`
 * attribute, so the same dispatch and the same `data-over` read work
 * unchanged on either.
 */
async function beginDrag(window: Page, from: string, to: string, prefix = COLUMN_PREFIX): Promise<void> {
  await window.evaluate(
    ([fromId, testidPrefix]) => {
      const source = document.querySelector(`[data-testid="${testidPrefix}${fromId}"]`) as
        | (HTMLElement & { __ptermDrag?: DataTransfer })
        | null
      if (!source) throw new Error(`missing row: ${testidPrefix}${fromId}`)
      const dataTransfer = new DataTransfer()
      source.__ptermDrag = dataTransfer
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    },
    [from, prefix],
  )

  await window.evaluate(
    ([fromId, toId, testidPrefix]) => {
      const source = document.querySelector(`[data-testid="${testidPrefix}${fromId}"]`) as
        | (HTMLElement & { __ptermDrag?: DataTransfer })
        | null
      const target = document.querySelector(`[data-testid="${testidPrefix}${toId}"]`)
      const dataTransfer = source?.__ptermDrag
      if (!source || !target || !dataTransfer) {
        throw new Error(`drag not started: ${testidPrefix}${fromId} -> ${testidPrefix}${toId}`)
      }
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }))
    },
    [from, to, prefix],
  )
}

/** Finishes a drag `beginDrag` started: `drop` on `to`, `dragend` on `from`. */
async function dropOn(window: Page, from: string, to: string, prefix = COLUMN_PREFIX): Promise<void> {
  await window.evaluate(
    ([fromId, toId, testidPrefix]) => {
      const source = document.querySelector(`[data-testid="${testidPrefix}${fromId}"]`) as
        | (HTMLElement & { __ptermDrag?: DataTransfer })
        | null
      const target = document.querySelector(`[data-testid="${testidPrefix}${toId}"]`)
      const dataTransfer = source?.__ptermDrag
      if (!source || !target || !dataTransfer) {
        throw new Error(`drag not started: ${testidPrefix}${fromId} -> ${testidPrefix}${toId}`)
      }
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
      delete source.__ptermDrag
    },
    [from, to, prefix],
  )
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-dragsplit-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-dragsplit-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-dragsplit-root-'))
  projectCwd = await seedProject('scratch', 'Scratch')
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-dragsplit-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-dragsplit-claude-'))
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dragging a tab onto another brackets them as one split', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  // The bar, not the column, makes a tab: `new-tab` lives in `TabBar.tsx`,
  // which `showsTabBar` only renders while the tabs column's full list is
  // NOT open (`TabsPanel.tsx`'s own doc comment says the two are never both
  // on screen). So every tab this file needs is opened first, through the
  // bar, and the column is opened only afterwards, to read the rows back.
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await ensureTabsColumnOpen(app, window)
  const [first, second] = await columnPaneIds(window)

  await beginDrag(window, second, first)
  // The hover accepted the pair before anything was dropped.
  await expect(window.getByTestId(`vpane-${first}`)).toHaveAttribute('data-over', 'true')
  await dropOn(window, second, first)

  await expect(window.getByTestId(`vpane-${first}`)).toHaveAttribute('data-bracket', 'first')
  await expect(window.getByTestId(`vpane-${second}`)).toHaveAttribute('data-bracket', 'last')
  // Still two sessions: a join MOVED a pane, it did not close one and spawn a
  // replacement. Two tmux sessions before this drag and two after is what
  // tells the two apart; the bracket alone would look the same either way.
  expect((await sessionNames(SOCKET)).length).toBe(2)

  await app.close()
})

test('a tab dropped on itself is refused', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  await ensureTabsColumnOpen(app, window)
  const [only] = await columnPaneIds(window)

  await beginDrag(window, only, only)
  // `canJoin(x, x)` refuses before a drop is ever sent: the hover itself
  // never accepts, which main's own guard cannot be credited for, since main
  // is never asked until a drop arrives.
  await expect(window.getByTestId(`vpane-${only}`)).not.toHaveAttribute('data-over', 'true')
  await dropOn(window, only, only)

  await expect(window.getByTestId(`vpane-${only}`)).not.toHaveAttribute('data-bracket', 'first')
  expect((await sessionNames(SOCKET)).length).toBe(1)

  await app.close()
})

test('a pane is refused as a drop target inside its own tab', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await ensureTabsColumnOpen(app, window)
  const [first, sibling] = await columnPaneIds(window)

  await beginDrag(window, sibling, first)
  // Same tab already: `canJoin`'s `tabOf(from) !== tabOf(to)` check refuses
  // the hover, not just the drop.
  await expect(window.getByTestId(`vpane-${first}`)).not.toHaveAttribute('data-over', 'true')
  await dropOn(window, sibling, first)

  // Unchanged from what the split already drew: still the last row of the
  // same two-pane bracket, not folded into a new one of its own.
  await expect(window.getByTestId(`vpane-${sibling}`)).toHaveAttribute('data-bracket', 'last')
  expect((await sessionNames(SOCKET)).length).toBe(2)

  await app.close()
})

/**
 * The same merge, driven through the tab BAR rather than the column.
 *
 * `hiddenColumns.tabs` starts `true` (`App.tsx:182`), so the bar, not the
 * column, is the surface most users meet: reaching the column at all needs a
 * trip through the View menu the other three tests in this file make and this
 * one does not. `TabBar.tsx` calls its own `usePaneDragDrop(canJoin, onJoin)`
 * rather than sharing the column's hook instance, so nothing already in this
 * file proves the bar's wiring, as opposed to the hook itself, actually works.
 *
 * The hover instrument carries over unchanged: `TabBar.tsx` sets the same
 * `data-over={drag.over === tab.id || undefined}` the column sets, from the
 * same hook. Only the CSS the attribute drives differs (an inset `boxShadow`
 * ring here, `TabsPanel.tsx`'s Tailwind ring class on the column), which is
 * a styling choice downstream of the same signal, not a second mechanism, so
 * the identical `data-over` read is what is asserted here too. The grouping
 * readout differs in name only: the bar has no `data-bracket`, but
 * `data-group-pos` carries the same three values (`TabTreeNode.pos`,
 * `lib/tabGroups.ts:35`).
 */
test('dragging a tab bar row onto another merges them through the bar itself', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const [first, second] = await barTabIds(window)

  await beginDrag(window, second, first, BAR_PREFIX)
  await expect(window.getByTestId(`tab-${first}`)).toHaveAttribute('data-over', 'true')
  await dropOn(window, second, first, BAR_PREFIX)

  await expect(window.getByTestId(`tab-${first}`)).toHaveAttribute('data-group-pos', 'first')
  await expect(window.getByTestId(`tab-${second}`)).toHaveAttribute('data-group-pos', 'last')
  // Same load-bearing check as the column's happy path: two sessions before
  // this drag, two after, so the bar moved a pane rather than closing one
  // and spawning a replacement.
  expect((await sessionNames(SOCKET)).length).toBe(2)

  await app.close()
})
