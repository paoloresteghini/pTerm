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
const row = (
  id: string,
  kids: string[],
  ratio: number[],
  // Defaulted, not fixed. A helper that always sets `activePaneId` to the first
  // kid makes a live row and a saved row agree about the selection whatever the
  // rule is, which is how a test can be written for the selection and still not
  // be able to see it. The tests that care pass this.
  activePaneId: string | null = kids[0] ?? null,
  groupId: string = id,
): TabRow => ({
  id,
  groupId,
  activePaneId,
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

  // A pane tmux has that config never knew about: the first relaunch after a
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

  // `restoreWorkspace` writes what this returns straight to disk, so preferring
  // the live row's selection does not merely mis-draw one run: it overwrites
  // the user's choice. The live row cannot be the authority here, because
  // `tabRowFor` resolved it against a pane set with no editor in it.
  it('keeps a saved selection the live row could not have named', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [row('tabA', ['t1'], [1], 't1')],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [row('tabA', ['t1', 'e1'], [0.5, 0.5], 'e1')],
    })
    expect(result.tabs[0]?.layout.kids).toEqual(['t1', 'e1'])
    expect(result.tabs[0]?.activePaneId).toBe('e1')
  })

  // Two saved rows sharing one `groupId`. `store.read()` accepts this and
  // `restore.ts`'s `savedByGroup` contemplates it outright ("First row wins").
  // `tabRowFor` cannot produce a pane in two rows because it is called once per
  // live group and filters against that group's panes; this function filters
  // against every live pane, so it has to say so itself.
  it('gives a pane to one row when two saved rows claim it', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [row('tabA', ['t1'], [1], 't1', 'g1')],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [
        row('tabA', ['t1', 'e1'], [0.5, 0.5], 't1', 'g1'),
        row('tabB', ['t1'], [1], 't1', 'g1'),
      ],
    })
    expect(result.tabs.map((tab) => tab.id)).toEqual(['tabA'])
    expect(result.tabs[0]?.layout.kids).toEqual(['t1', 'e1'])
  })

  // The same invariant on the other loop: a saved row naming a pane that is
  // live in a DIFFERENT group. The live group's row has no saved row of its
  // own, so it is appended rather than matched, and it must not bring a second
  // copy of the pane with it.
  it('gives a pane to one row when a saved row and a live-only row claim it', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [row('t1', ['t1'], [1], 't1')],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [row('tabOld', ['t1', 'e1'], [0.5, 0.5], 't1', 'gOld')],
    })
    expect(result.tabs.map((tab) => tab.id)).toEqual(['tabOld'])
    expect(result.tabs[0]?.layout.kids).toEqual(['t1', 'e1'])
    // Every pane is in exactly one row, which is what the two assertions above
    // are really one half of each.
    const everyKid = result.tabs.flatMap((tab) => tab.layout.kids)
    expect(everyKid).toHaveLength(new Set(everyKid).size)
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
