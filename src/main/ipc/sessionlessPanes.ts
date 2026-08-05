import type { PaneRecord } from '../sessions/manager'
import type { TabRow } from '../state/store'
import { sharesAroundClaims } from './shares'

export interface MergeInput {
  /**
   * What live tmux gave back, already attached.
   *
   * `restoreWorkspace` holds these as `TabDescriptor[]`, which is the same
   * shape by construction — the two are one definition split across the wire
   * boundary, and `restore.ts`'s own import comment says so.
   */
  livePanes: PaneRecord[]
  /** The tab rows built from those live panes. */
  liveTabs: TabRow[]
  /** Every pane row on disk, including the ones tmux knows nothing about. */
  savedPanes: PaneRecord[]
  /** Every tab row on disk. */
  savedTabs: TabRow[]
}

export interface MergeResult {
  panes: PaneRecord[]
  tabs: TabRow[]
}

/**
 * Live restore's answer, plus the panes it could not have known about.
 *
 * `restoreWorkspace` starts from tmux: it asks what sessions exist, attaches
 * them, and builds one tab row per live group. That is the right shape for a
 * terminal and the wrong shape for a pane that never had a session, which
 * would be absent from the reply and then written away by the config write
 * that follows it.
 *
 * So this is additive and narrow. It puts back exactly the saved panes whose
 * kind has no session, and it never resurrects a terminal: a saved terminal
 * row missing from `livePanes` is a session tmux says is gone, which is the
 * judgement this function must not second-guess.
 *
 * A sessionless pane rejoins the tab its saved row named. If that tab also
 * came back live, the pane is inserted in the saved kid order; if every other
 * pane in it died, the tab survives on its sessionless panes alone, because
 * an editor cannot die and a tab holding one is not empty. A sessionless pane
 * whose tab row is gone is dropped: a pane no tab holds cannot be reached,
 * focused, or closed.
 *
 * Pure, and it has to stay that way: `vitest` runs `environment: 'node'`, and
 * the whole reason this decision lives here rather than inline in
 * `restoreWorkspace` is that it can then be tested with no tmux and no
 * Electron.
 */
export function mergeSessionlessPanes(input: MergeInput): MergeResult {
  const { livePanes, liveTabs, savedPanes, savedTabs } = input

  // By kind, never by "has no session". A terminal row missing its session was
  // already rejected by `isPane`, and treating absence as sessionlessness here
  // would put exactly those malformed rows back.
  const sessionless = savedPanes.filter((pane) => pane.type === 'editor')
  if (sessionless.length === 0) return { panes: livePanes, tabs: liveTabs }

  const liveIds = new Set(livePanes.map((pane) => pane.id))
  const survivors = new Map<string, PaneRecord>()
  for (const pane of sessionless) {
    // A pane already in the live answer needs nothing: it cannot be there,
    // but if a future kind is both sessionless and attachable, this keeps the
    // function from listing it twice.
    if (!liveIds.has(pane.id)) survivors.set(pane.id, pane)
  }

  const liveById = new Map(liveTabs.map((tab) => [tab.id, tab]))
  const tabs: TabRow[] = []
  const placed = new Set<string>()

  // Saved order, so a tab's position on disk does not depend on whether its
  // panes happened to be live ones.
  for (const saved of savedTabs) {
    const live = liveById.get(saved.id)
    // Every kid that is still real: a live pane, or a sessionless one that
    // cannot have died. A saved terminal absent from `livePanes` is a session
    // tmux says is gone, and this function does not second-guess that.
    //
    // Saved order first, then whatever the live row holds that the saved row
    // never named — `tabRowFor`'s rule, for `tabRowFor`'s reason: a tab split
    // during the last run has no multi-pane row on disk, so on the first
    // relaunch after a split every sibling arrives only through the live row,
    // and filtering the saved kids alone would drop it out of its tab.
    const liveKids = live?.layout.kids ?? []
    const kids = [
      ...saved.layout.kids.filter((id) => liveIds.has(id) || survivors.has(id)),
      ...liveKids.filter((id) => !saved.layout.kids.includes(id)),
    ]
    if (kids.length === 0) continue

    for (const id of kids) if (survivors.has(id)) placed.add(id)

    // Untouched when the live row already holds exactly these kids: the live
    // row carries whatever restore resolved for it, and rebuilding it from the
    // saved row would put a stale axis or stale ratios back over that.
    if (
      live &&
      live.layout.kids.length === kids.length &&
      live.layout.kids.every((id, at) => id === kids[at])
    ) {
      tabs.push(live)
      continue
    }

    const source = live ?? saved
    // The saved row's share for every kid it names, the live row's for a kid
    // only tmux knew about, and an even share for neither — then renormalised
    // by `sharesAroundClaims`, which with no claims among the entries is
    // exactly the `share / total` rescale this needs. Reused rather than
    // rewritten: a row whose `ratio` does not sum to 1 over its own `kids` is
    // the bug class that function exists to prevent, and a second renormaliser
    // is how one of the two goes dead without a test noticing.
    //
    // The saved row is preferred because it is the only one holding a share
    // for the sessionless pane at all: the live row was built over the panes
    // that came back, so mixing the two would put one kid's whole-tab share
    // beside its siblings' shares of a smaller tab.
    const even = 1 / kids.length
    const ratio = sharesAroundClaims(
      kids.map((id) => {
        const at = saved.layout.kids.indexOf(id)
        if (at !== -1) return { base: saved.layout.ratio[at] ?? even }
        const liveAt = liveKids.indexOf(id)
        if (live && liveAt !== -1) return { base: live.layout.ratio[liveAt] ?? even }
        return { base: even }
      }),
    )
    // Selection has to name a pane this tab still holds. The live row's choice
    // first — restore resolved it against the panes that came back, and those
    // are all still kids here — then the saved one, then the first kid, which
    // is what a null `activePaneId` already means.
    const active = live?.activePaneId ?? saved.activePaneId
    tabs.push({
      ...source,
      activePaneId: active !== null && kids.includes(active) ? active : (kids[0] ?? null),
      layout: { ...source.layout, ratio, kids },
    })
  }

  // A live tab with no saved row at all: a tab founded this session. Kept as
  // it is, and appended, since no saved order can place it.
  for (const tab of liveTabs) {
    if (!savedTabs.some((saved) => saved.id === tab.id)) tabs.push(tab)
  }

  // Saved pane order, because that order is what the user sees: the tab bar
  // lists `state.panes` filtered by project, and `paneGroups` orders the
  // groups by where each tab's first pane appears in it. Appending every
  // sessionless pane after every live one would walk an editor tab to the end
  // of the bar on each relaunch. Live panes no saved row names go last, which
  // is where `restoreWorkspace` already puts them.
  //
  // Only the sessionless panes a tab actually holds. One no tab holds cannot
  // be reached, focused or closed, so it is dropped rather than orphaned.
  const liveByPaneId = new Map(livePanes.map((pane) => [pane.id, pane]))
  const panes: PaneRecord[] = []
  for (const saved of savedPanes) {
    const pane = liveByPaneId.get(saved.id)
    if (pane) {
      panes.push(pane)
      liveByPaneId.delete(saved.id)
      continue
    }
    if (placed.has(saved.id)) panes.push(saved)
  }
  panes.push(...liveByPaneId.values())

  return { panes, tabs }
}
