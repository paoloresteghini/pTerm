import type { PaneRecord } from '../sessions/manager'
import type { TabRow } from '../state/store'
import { sharesAroundClaims } from './shares'

export interface MergeInput {
  /**
   * What live tmux gave back, already attached.
   *
   * `restoreWorkspace` holds these as `TabDescriptor[]`, which is the same
   * shape by construction: the two are one definition split across the wire
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
  // Every pane an emitted row already holds. `tabRowFor` never needed this: it
  // is called once per live GROUP and filters against that group's own panes,
  // so "a pane is in exactly one row" was true of it by construction. This
  // function filters against every live pane in the workspace instead, which
  // is a wider test and on its own guarantees nothing, so the guarantee is
  // made explicit here. First row wins, which is the rule `store.ts`'s
  // `tabRows` already applies with its shrinking `known` set and the one
  // `restore.ts`'s `savedByGroup` states outright.
  //
  // Two configs reach this without it, both of which `store.read()` accepts:
  // a saved row whose `groupId` is not the live group its panes are in, and
  // two saved rows sharing one `groupId`. The next `store.read()` heals the
  // file either way, but the REPLY is not healed, and a pane drawn in two tabs
  // at once has no sane rendering for the run it happens in.
  const claimed = new Set<string>()

  // Saved order, so a tab's position on disk does not depend on whether its
  // panes happened to be live ones.
  for (const saved of savedTabs) {
    const live = liveById.get(saved.id)
    // Every kid that is still real, and not already spoken for: a live pane, or
    // a sessionless one that cannot have died. A saved terminal absent from
    // `livePanes` is a session tmux says is gone, and this function does not
    // second-guess that.
    //
    // Saved order first, then whatever the live row holds that the saved row
    // never named. That is `tabRowFor`'s rule, for `tabRowFor`'s reason: a tab
    // split during the last run has no multi-pane row on disk, so on the first
    // relaunch after a split every sibling arrives only through the live row,
    // and filtering the saved kids alone would drop it out of its tab.
    const liveKids = live?.layout.kids ?? []
    const kids = [
      ...saved.layout.kids.filter(
        (id) => (liveIds.has(id) || survivors.has(id)) && !claimed.has(id),
      ),
      ...liveKids.filter((id) => !saved.layout.kids.includes(id) && !claimed.has(id)),
    ]
    if (kids.length === 0) continue

    for (const id of kids) {
      claimed.add(id)
      if (survivors.has(id)) placed.add(id)
    }

    // Untouched when the live row already holds exactly these kids: the live
    // row carries whatever restore resolved for it, and rebuilding it from the
    // saved row would put a stale axis or stale ratios back over that. Length
    // equality also means nothing was taken by an earlier row, since `kids` is
    // built from the live kids minus whatever was claimed.
    if (
      live &&
      live.layout.kids.length === kids.length &&
      live.layout.kids.every((id, at) => id === kids[at])
    ) {
      tabs.push(live)
      continue
    }

    const source = live ?? saved
    tabs.push({
      ...source,
      activePaneId: selectionFor(kids, [saved, live]),
      layout: { ...source.layout, ratio: sharesFor(kids, [saved, live]), kids },
    })
  }

  // A live tab with no saved row at all: a tab founded this session. Appended,
  // since no saved order can place it, and filtered by `claimed` like any
  // other: a saved row naming a pane that is live in a DIFFERENT group is
  // exactly how one pane reaches two rows, and the row it reaches second is
  // this one.
  for (const tab of liveTabs) {
    if (savedTabs.some((saved) => saved.id === tab.id)) continue
    const kids = tab.layout.kids.filter((id) => !claimed.has(id))
    if (kids.length === 0) continue
    for (const id of kids) claimed.add(id)
    if (kids.length === tab.layout.kids.length) {
      tabs.push(tab)
      continue
    }
    tabs.push({
      ...tab,
      activePaneId: selectionFor(kids, [tab]),
      layout: { ...tab.layout, ratio: sharesFor(kids, [tab]), kids },
    })
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

/**
 * Shares for `kids`, each taken from the first row that names it, then
 * renormalised so the vector sums to 1 over exactly those kids.
 *
 * `sharesAroundClaims` rather than a second renormaliser: with no claim among
 * the entries it is exactly the `share / total` rescale needed here, as its own
 * docstring records, and a row whose `ratio` does not sum to 1 over its own
 * `kids` is the bug class that function exists to prevent. Two copies of one
 * rescale is how one of them goes dead without a test noticing.
 *
 * Row order is the caller's preference, and callers pass the saved row first.
 * The saved row is the only one holding a share for a sessionless pane at all:
 * the live row was built over the panes that came back, so taking the live
 * value where both name a kid would put one kid's whole-tab share beside its
 * siblings' shares of a smaller tab. A kid no row names takes an even share.
 */
function sharesFor(kids: readonly string[], rows: readonly (TabRow | undefined)[]): number[] {
  const even = 1 / kids.length
  return sharesAroundClaims(
    kids.map((id) => {
      for (const row of rows) {
        if (row === undefined) continue
        const at = row.layout.kids.indexOf(id)
        if (at !== -1) return { base: row.layout.ratio[at] ?? even }
      }
      return { base: even }
    }),
  )
}

/**
 * The selected pane for a rebuilt row: the first row's choice that `kids` still
 * holds, else the first kid.
 *
 * Callers pass the saved row first, and that order is the whole point.
 * `restoreWorkspace` writes what this returns straight to disk, and the live
 * row's selection was resolved by `tabRowFor` against a pane set that did not
 * contain the sessionless panes, so preferring it would overwrite the user's
 * saved choice whenever that choice was an editor. Saved first also matches
 * `tabRowFor` itself, which reads the SAVED `activePaneId` and falls back to
 * `kids[0]` only when that pane is no longer a kid.
 *
 * Tested for null explicitly rather than coalesced with `??`, which does not
 * distinguish "this row has no selection" from "there is no such row": a row
 * genuinely saying null should fall through to the next, and that is a
 * different sentence from the one `??` writes.
 */
function selectionFor(
  kids: readonly string[],
  rows: readonly (TabRow | undefined)[],
): string | null {
  for (const row of rows) {
    const id = row?.activePaneId
    if (id !== null && id !== undefined && kids.includes(id)) return id
  }
  return kids[0] ?? null
}
