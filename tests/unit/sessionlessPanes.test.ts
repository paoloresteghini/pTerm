import { describe, it, expect } from 'vitest'
import { mergeSessionlessPanes } from '../../src/main/ipc/sessionlessPanes'
import type { PaneRecord } from '../../src/main/sessions/manager'
import type { TabRow } from '../../src/main/state/store'

const term = (id: string): PaneRecord => ({
  id,
  projectSlug: 'demo',
  cwd: '/tmp/demo',
  type: 'shell',
  tmuxSession: `prcli-demo-${id}`,
})

const editor = (id: string, filePath = `/tmp/demo/${id}.ts`): PaneRecord => ({
  id,
  projectSlug: 'demo',
  cwd: '/tmp/demo',
  type: 'editor',
  filePath,
})

/**
 * A tab row exactly as `store.read()` hands one back: `kids`, `ratio` and the
 * axis live under `layout`, and the row carries an `activePaneId` beside them.
 * `groupId` defaults to the row's own id, which is what every tab that has
 * never re-founded has.
 */
const row = (id: string, kids: string[], ratio: number[]): TabRow => ({
  id,
  groupId: id,
  activePaneId: kids[0] ?? null,
  layout: { dir: 'row', ratio, kids },
})

describe('mergeSessionlessPanes', () => {
  // The whole point. Restore returns what tmux had; an editor pane was never
  // in that answer and would be written away by the config write that follows.
  it('adds a saved editor pane that live restore could not know about', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [row('tabA', ['t1'], [1])],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [row('tabA', ['t1'], [1]), row('tabE', ['e1'], [1])],
    })
    expect(result.panes.map((pane) => pane.id)).toEqual(['t1', 'e1'])
    expect(result.tabs.map((tab) => tab.id)).toEqual(['tabA', 'tabE'])
    expect(result.panes.find((pane) => pane.id === 'e1')?.filePath).toBe('/tmp/demo/e1.ts')
  })

  // A dead terminal must still be dropped. This function adds sessionless
  // panes back; it is not a licence to resurrect panes tmux said were gone.
  it('does not bring back a terminal pane restore dropped', () => {
    const result = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: [term('t1')],
      savedTabs: [row('tabA', ['t1'], [1])],
    })
    expect(result.panes).toEqual([])
    expect(result.tabs).toEqual([])
  })

  // A tab holding one live terminal and one editor: the editor rejoins the
  // tab it was in rather than becoming a tab of its own.
  it('returns an editor pane to a tab that survived', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [row('tabA', ['t1'], [1])],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [row('tabA', ['t1', 'e1'], [0.5, 0.5])],
    })
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.layout.kids).toEqual(['t1', 'e1'])
    expect(result.tabs[0]?.layout.ratio).toEqual([0.5, 0.5])
  })

  // The mixed tab whose terminal died. The editor is still here, so the tab
  // is still here, holding only the editor and summing to 1.
  it('keeps a mixed tab alive on its editor alone when the terminal died', () => {
    const result = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [row('tabA', ['t1', 'e1'], [0.5, 0.5])],
    })
    expect(result.panes.map((pane) => pane.id)).toEqual(['e1'])
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.layout.kids).toEqual(['e1'])
    expect(result.tabs[0]?.layout.ratio).toEqual([1])
    // Selection has to name a pane the tab still holds: the dead terminal was
    // the saved choice, and a row pointing at it would hand the renderer an
    // active pane that is not in the tab.
    expect(result.tabs[0]?.activePaneId).toBe('e1')
  })

  // An editor row with no tab row at all. It must not appear as a pane no tab
  // holds, which is a pane the user cannot reach or close.
  it('drops an editor pane no saved tab holds', () => {
    const result = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: [editor('e1')],
      savedTabs: [],
    })
    expect(result.panes).toEqual([])
    expect(result.tabs).toEqual([])
  })

  // Pane order is tab-bar order (`tabsOfProject` filters `state.panes`) and
  // group order (`paneGroups` follows first appearance in it), so appending
  // every editor after every terminal would move an editor tab to the end of
  // the bar on each relaunch.
  it('puts an editor pane back where saved pane order had it', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1'), term('t2')],
      liveTabs: [row('tabA', ['t1'], [1]), row('tabB', ['t2'], [1])],
      savedPanes: [term('t1'), editor('e1'), term('t2')],
      savedTabs: [row('tabA', ['t1'], [1]), row('tabE', ['e1'], [1]), row('tabB', ['t2'], [1])],
    })
    expect(result.panes.map((pane) => pane.id)).toEqual(['t1', 'e1', 't2'])
  })

  // A pane tmux has that config never knew about — the first relaunch after a
  // split, which `tabRowFor` appends rather than ignores. Rebuilding a tab
  // from its saved kids alone would drop it out of the tab it is in.
  it('keeps a live kid the saved row never named', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1'), term('t2')],
      liveTabs: [row('tabA', ['t1', 't2'], [0.5, 0.5])],
      savedPanes: [term('t1'), term('t2'), editor('e1')],
      savedTabs: [row('tabA', ['t1', 'e1'], [0.5, 0.5])],
    })
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.layout.kids).toEqual(['t1', 'e1', 't2'])
    expect(result.tabs[0]?.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    expect(result.tabs[0]?.layout.ratio).toHaveLength(3)
  })

  it('is a no-op when nothing saved is sessionless', () => {
    const live = [term('t1')]
    const tabs = [row('tabA', ['t1'], [1])]
    const result = mergeSessionlessPanes({
      livePanes: live,
      liveTabs: tabs,
      savedPanes: live,
      savedTabs: tabs,
    })
    expect(result.panes).toEqual(live)
    expect(result.tabs).toEqual(tabs)
  })
})
