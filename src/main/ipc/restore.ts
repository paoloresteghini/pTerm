import { homedir } from 'node:os'
import type { SessionManager, PaneRecord, TerminalPaneRecord } from '../sessions/manager'
import type { ConfigStore, ProjectRecord, TabRow } from '../state/store'
import { readManifest, mergePresets } from '../projects/manifest'
import { isDirectory } from '../fsutil'
import { sharesAroundClaims, claimFor, tombstonesOf, inLiveFrame, type Claim } from './shares'
import { attachSavedFields } from './savedFields'
// One definition, shared with the renderer — `TabDescriptor` and `PaneRecord`
// are the same shape, and duplicating the types here would let them drift.
import {
  UNSORTED_ID,
  type ProjectDescriptor,
  type RestoreResult,
  type TabDescriptor,
} from '../../shared/ipc'

/**
 * Turn stored project rows into what the renderer draws: presets merged with
 * the repo's own, each project's active tab resolved against the tabs it is
 * given, and whether its directory still exists.
 *
 * Returns one descriptor per project, in the order the projects came in, so a
 * caller holding both lists can index one by the other.
 *
 * Appending Unsorted is `withUnsorted`'s job, not this one's: restore resolves
 * the selected project against the appended list, and the mutation handlers
 * write config before appending. Both wrap this, and neither wants the append
 * buried in it.
 */
export async function describeProjects(
  projects: ProjectRecord[],
  tabs: TabDescriptor[],
): Promise<ProjectDescriptor[]> {
  const described: ProjectDescriptor[] = []
  for (const project of projects) {
    const own = tabs.filter((tab) => tab.projectSlug === project.slug)
    described.push({
      id: project.id,
      name: project.name,
      slug: project.slug,
      cwd: project.cwd,
      presets: mergePresets(project.presets, await readManifest(project.cwd)),
      // The saved choice when its session came back, else this project's first.
      activeTabId: own.find((tab) => tab.id === project.activeTabId)?.id ?? own[0]?.id ?? null,
      available: await isDirectory(project.cwd),
    })
  }
  return described
}

/**
 * Append the synthetic Unsorted project when any live tab's slug matches no
 * real project. Unsorted exists only while something is in it.
 *
 * Exported because every project mutation must answer with the same list
 * restore does: after a project is removed its sessions are still running, and
 * a reply that omitted Unsorted would drop them off the screen until the next
 * launch.
 */
export function withUnsorted(
  projects: ProjectDescriptor[],
  tabs: TabDescriptor[],
): ProjectDescriptor[] {
  const known = new Set(projects.map((project) => project.slug))
  const strays = tabs.filter((tab) => !known.has(tab.projectSlug))
  if (strays.length === 0) return projects
  return [
    ...projects,
    {
      id: UNSORTED_ID,
      name: 'Unsorted',
      slug: UNSORTED_ID,
      // Never used to launch anything — every tab here has its own cwd.
      cwd: homedir(),
      presets: [],
      // Deliberately not persisted: this is a place to rehome a stray, not one
      // to live in.
      activeTabId: strays[0].id,
      available: true,
    },
  ]
}

/**
 * Everything `restoreWorkspace` itself can answer. `CHANNELS.restore`'s
 * handler in `register.ts` adds `status` on top, from the registry it — not
 * this function — has access to; see `RestoreResult.status`.
 */
export type WorkspaceReconcile = Omit<RestoreResult, 'status'>

/**
 * One live tab's panes, minus any whose member session is showing a window
 * another member of the same tab has already claimed.
 *
 * A member's binding to its window is tmux server state and outlives every
 * client, so a reattach never has to restore it — measured: a member still
 * reads its own `@1 1` after the client that bound it has gone and a
 * `new-session -A` has attached a new one. But when a member's OWN window
 * dies, that member silently falls back to a sibling's (measured, `@0 0`) and
 * its session survives. Both members then name one window, and giving each of
 * them a client would render one pane in two xterms and size that one window
 * twice.
 *
 * Re-binding is not the repair and was measured not to be: the only window
 * this app could bind a member to is the one that member already reports,
 * which is either already right (a no-op) or the sibling's (cementing the
 * fault). Detecting it is what is left, so the shadowing pane is dropped from
 * the tab — and its session killed, which is not the same as dropping it. A
 * pane whose session has gone needs nothing further; this one's session is
 * alive, and a pane dropped from the tab without being killed is a running
 * `prcli-*` session with no row on disk and no way back into the UI.
 *
 * Which of the two members truly owns the surviving window is not recoverable
 * from tmux: killing either side's window leaves both members reporting the
 * survivor — measured in both directions — and nothing on a window records the
 * member it was made for. The window's own `pane-died` hook does name one, and
 * is deliberately not consulted: that hook, when it runs, kills the member
 * session of the pane whose window died, so a member that has outlived its
 * window is by definition one whose hook did not run, and reading it back
 * would be least reliable exactly where it is needed.
 *
 * So the founder is preferred — the pane whose id is the tab's, which is the
 * direction pre-flight measured (a joined member falling back onto the
 * founder's window). When the guess is wrong the surviving process is still
 * shown, once, under the other pane's id and saved cwd/command/type; when
 * nothing prunes at all it is shown twice, which is the failure this exists
 * for.
 *
 * `tab.panes` is always `TerminalPaneRecord[]`: the only caller passes what
 * `manager.findOrphanTabs()` returned, which is built entirely from live
 * tmux session names and never produces an editor pane.
 */
async function withoutSharedWindows(
  manager: SessionManager,
  tab: { tabId: string; panes: TerminalPaneRecord[] },
): Promise<PaneRecord[]> {
  // A tab of one pane has no sibling to shadow, and asking tmux for its window
  // would put a round trip on every ordinary unsplit tab for nothing.
  if (tab.panes.length < 2) return tab.panes

  const founderFirst = [
    ...tab.panes.filter((pane) => pane.id === tab.tabId),
    ...tab.panes.filter((pane) => pane.id !== tab.tabId),
  ]
  const claimed = new Set<string>()
  const kept: PaneRecord[] = []
  for (const pane of founderFirst) {
    const window = await manager.windowOfMember(pane.tmuxSession)
    // An empty answer is "tmux would not say", not "the same window as its
    // sibling" — two panes tmux declined to describe are not evidence of
    // anything, and pruning a live session on that would lose a pane rather
    // than deduplicate one.
    if (window && claimed.has(window)) {
      // Dropped from the tab AND killed. Dropping alone is what leaves a live
      // `prcli-*` session with no config row, no tab-bar entry and nothing in
      // the app able to reach it — pruned again on every future restore, for
      // as long as it runs. Its session is all there is to kill: it has no
      // window of its own (that is what made it shadow one), and the window
      // it reports belongs to the pane being kept.
      await manager.killShadowMember(pane.tmuxSession)
      continue
    }
    if (window) claimed.add(window)
    kept.push(pane)
  }
  return kept
}

/**
 * The tab row for one tab, given the panes it holds and the row saved for it.
 *
 * Existence is settled before this runs — `ids` is what the tab actually
 * holds, and is never empty. All this adds is what tmux cannot report: the axis,
 * the ratios and which pane was selected, taken from the saved row where it
 * still describes panes that are here.
 *
 * A pane the saved row never knew about is appended rather than ignored: a tab
 * split during the last run has no multi-pane row on disk at all (nothing
 * writes one yet), so on the first relaunch after a split every sibling
 * arrives this way.
 *
 * Exported for `register.ts`'s `closePane`, which had grown its own copy of
 * this — the same union, the same saved-share-or-even, the same rescale and
 * the same `activePaneId` fallback, line for line. Two copies of one algorithm
 * is how the rescale that keeps a row summing to 1 goes dead in one of them
 * without a test noticing, since `store.read()` rescales on the way back in.
 *
 * `tab` is passed whole rather than derived from `saved`, because the two
 * callers know the tab's identity by different routes and only they can say:
 * restore starts from a live tmux group and takes the stable id off whatever
 * row matches it, while `closePane` starts from the manager's own record of
 * the tab and asks tmux which group that tab is in now.
 */
export function tabRowFor(
  tab: { id: string; groupId: string },
  ids: string[],
  saved: TabRow | undefined,
  /**
   * Every claim recorded so far, across every tab — `register.ts`'s
   * `tombstones`, read here through `claimFor` (for a kid the saved row does
   * not know) and `tombstonesOf` (for a pane of THIS tab that `ids` does not
   * name at all — a tombstone still on screen). Both filter on `tab.id`
   * before ever reading `share`; see `shares.ts`'s `Claim`. Absent for
   * restore, which prunes dead panes at launch and so never meets one.
   */
  tombstones?: ReadonlyMap<string, Claim>,
): TabRow {
  const savedKids = saved?.layout.kids ?? []
  const kids = [
    ...savedKids.filter((kid) => ids.includes(kid)),
    ...ids.filter((id) => !savedKids.includes(id)),
  ]

  // A kid the saved row knew keeps its own share, relative to the other kids
  // it knew; a kid it does not know but that is REMEMBERED — a pane that died
  // and came back — claims the share it died at outright, and the rest scale
  // into what that leaves. Anything else takes an even share. `store.read()`
  // has already made the saved shares positive, finite and one per kid, and it
  // is the same reader `register.ts`'s `tombstones` is captured through, so
  // both inputs here are shares of a whole tab.
  //
  // The rescale that used to live here is `sharesAroundClaims`'s job, and it
  // is not optional: dropping a kid leaves the survivors summing to less than
  // 1, and appending one leaves them summing to more. A layout that does not
  // describe a whole tab renders every pane in it at the wrong size — and
  // `store.read()` would quietly rescale it on the way back in, so nothing
  // downstream would ever report the loss.
  const even = 1 / kids.length
  const claims = tombstones ?? new Map()
  // The whole tab: `kids` — the row about to be WRITTEN — plus every pane of
  // this tab a claim is still owed to that `kids` does NOT name: a tombstone
  // still on screen. See `carveRatio`'s matching comment in `register.ts`.
  const dead = tombstonesOf(tab.id, kids, claims)
  const whole = sharesAroundClaims([
    ...kids.map((kid) => {
      const at = savedKids.indexOf(kid)
      if (at !== -1 && saved) return { base: saved.layout.ratio[at] }
      const claim = claimFor(tab.id, kid, claims)
      return claim === undefined ? { base: even } : { claim, base: claim }
    }),
    ...dead.map((entry) => ({ claim: entry.share, base: entry.share })),
  ])
  // Appended above, selected by id here: see `inLiveFrame`.
  const shares = inLiveFrame(whole, [...kids, ...dead.map((entry) => entry.id)], kids)

  // The saved selection only if that pane is still one of this tab's, else the
  // first one — which is what a null `activePaneId` means anyway, said outright
  // so no reader has to know that.
  const active = saved?.activePaneId
  return {
    // Never a surviving pane's id: a group outlives its founder, and a row
    // renamed after whichever sibling happened to survive would stop matching
    // the tab on the next restore — and, in the same instant, unmount the tab
    // in the renderer, which keys its container on this.
    id: tab.id,
    groupId: tab.groupId,
    activePaneId: active && kids.includes(active) ? active : kids[0],
    layout: {
      dir: saved?.layout.dir ?? 'row',
      ratio: shares,
      kids,
    },
  }
}

/**
 * Reconcile the saved workspace against what tmux actually has.
 *
 * Live tmux sessions decide what exists — which panes, and which tab each one
 * belongs to; config supplies display order, which project is selected, which
 * tab is active inside each, and each tab's axis and drag ratios, which are the
 * two things tmux genuinely cannot report. Deriving existence from config
 * instead is what made a session the app had lost track of unreachable from the
 * UI.
 *
 * A tab belongs to the project whose slug its session name carries. Nothing
 * stores that association, so it cannot go stale, and Unsorted is a definition
 * — tabs matching no project — rather than a list anyone maintains.
 *
 * The whole reconcile runs inside the caller's config write queue: it reads and
 * then writes, and an interleaved write from `open` or an exit would otherwise
 * be lost. Nothing inside it may call `serialise` again — that queue has no
 * reentrancy protection and would deadlock without a word.
 */
export async function restoreWorkspace(
  manager: SessionManager,
  store: ConfigStore,
  serialise: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<WorkspaceReconcile> {
  return serialise(async () => {
    const saved = await store.read()

    // Any client we still hold is stale here by definition: a restore means
    // the renderer that owned it is gone. `findOrphans` excludes sessions we
    // have attached, so without this a second restore in one app lifetime — a
    // ⌘R, a renderer crash — sees nothing, returns an empty workspace and
    // writes it over config, stranding every session the user had open.
    // Detaching first also makes tmux redraw each pane into the fresh xterm.
    manager.detachAll()

    // Grouped by live tmux, not by anything saved: `findOrphanTabs` reads each
    // pane's `session_group`, which is what a split tab actually is, and takes
    // its id from the group name's frozen id half. Its slug is never read — a
    // pane's project comes from that pane's own session name.
    //
    // What it hands back is the GROUP's id, which is the tab's own id for
    // every tab that still has the group it was founded with, and a different
    // pane's for one that has re-founded since. The saved rows are what turn
    // one into the other, below.
    const liveTabs: { tabId: string; panes: PaneRecord[] }[] = []
    for (const tab of await manager.findOrphanTabs()) {
      liveTabs.push({ tabId: tab.tabId, panes: await withoutSharedWindows(manager, tab) })
    }

    const byId = new Map<string, PaneRecord>()
    // Keyed by the live GROUP's id — the only id tmux can report — which is
    // the tab's own for every tab that has not re-founded.
    const groupOf = new Map<string, string>()
    for (const tab of liveTabs) {
      for (const pane of tab.panes) {
        byId.set(pane.id, pane)
        groupOf.set(pane.id, tab.tabId)
      }
    }

    // The saved row for a group, by the group id that row was last seen in.
    //
    // Matched on `groupId` and never on `id`, because the group is all live
    // tmux knows: a tab that re-founded while the app was running is in a
    // group named after a different pane than the one its row is keyed by, and
    // matching on `id` would find nothing, lose the tab's layout and hand the
    // renderer a tab it has never seen. First row wins, which is a formality —
    // the writers keep one row per tab id (`withTabRow` replaces by id, and
    // this function's own caller replaces `tabs` wholesale), and a tab's group
    // is one tab's, so distinct groups resolve to distinct rows.
    const savedByGroup = new Map<string, TabRow>()
    for (const row of saved.tabs) {
      if (!savedByGroup.has(row.groupId)) savedByGroup.set(row.groupId, row)
    }
    /** The tab id a group belongs to: its saved row's, or the group's own. */
    const tabIdOfGroup = (groupId: string): string => savedByGroup.get(groupId)?.id ?? groupId

    // Saved order first, skipping rows whose session is gone.
    //
    // Skipped, never reopened, and that is the whole answer to a saved pane
    // whose session has died: `manager.open()` creates with `new-session -A`
    // and no `-t <group>`, so reopening one from its saved row would create it
    // afresh OUTSIDE the group its tab is — silently un-splitting the tab and
    // putting a brand-new shell where the user's dead pane was. Every pane
    // below came out of live tmux, so nothing here can reach `open()` with a
    // name tmux does not already have; a dead pane is pruned from the layout
    // instead, by `tabRowFor` never being given it.
    const ordered: PaneRecord[] = []
    for (const row of saved.panes) {
      const pane = byId.get(row.id)
      if (!pane) continue
      byId.delete(row.id)
      // The saved row carries the real cwd, command and type; the live pane's
      // are synthesised and, for type, always 'shell' — using them here would
      // downgrade a claude or preset tab back to plain shell on every restore.
      ordered.push({ ...pane, cwd: row.cwd, command: row.command, type: row.type })
    }
    // Then anything tmux has that config did not know about.
    ordered.push(...byId.values())

    const panes: TabDescriptor[] = []
    for (const record of ordered) {
      try {
        panes.push(
          manager.open({
            id: record.id,
            projectSlug: record.projectSlug,
            cwd: record.cwd,
            command: record.command,
            tmuxSession: record.tmuxSession,
            type: record.type,
            // The tab this pane is a member of, from the live group it was
            // found in — the same map `held` below groups by, handed to the
            // manager instead of being computed here and dropped.
            //
            // This line is the whole of adoption for `manager.open`'s `tabId`,
            // and adopted panes are most panes in real use: every one the app
            // did not itself create this run. A previous run's manager is gone
            // with everything it recorded, and by the time a restart is asked
            // for, the pane's own session — which held its membership — has
            // been killed by the death hook. Drop it and a restarted sibling
            // comes back OUTSIDE its tab's group, which the next restore reads
            // as a tab of its own. That is finding I4, for the majority case.
            //
            // The fallback is total for the same reason `held`'s is: every
            // record here came out of a group above, and a pane that is its own
            // tab is what an ungrouped session already is.
            //
            // The TAB's id, not the group's, and that is the whole of adoption
            // for a tab that has re-founded: the manager hands this back to
            // every writer of a tab row for as long as this run lasts, so a
            // pane adopted under its group's id would put the tab in the bar
            // twice the first time one of its panes was split or closed.
            tabId: tabIdOfGroup(groupOf.get(record.id) ?? record.id),
          }),
        )
      } catch (error) {
        // One session that will not attach must not cost the user the ones
        // that did — with twelve tabs, rejecting the whole restore would leave
        // every other session attached and invisible. tmux still has this one,
        // so the next restore finds it again and tries afresh.
        //
        // But silent: a `catch {}` that discards the error leaves a pane that
        // fails on every relaunch invisible forever — the one case where this
        // tool, whose whole job is surfacing which of a dozen sessions needs
        // attention, hides exactly that. `record.tmuxSession` rather than the
        // bare id: it carries the project slug too, so it reads as something
        // the user placed rather than an opaque hex string.
        console.warn(`PRCLI: could not attach ${record.tmuxSession} on restore`, error)
        continue
      }
    }

    // The panes that actually attached, back under the tab each one belongs
    // to, in the order those panes are listed above — so a tab's position
    // follows saved pane order for the same reason the panes themselves do.
    const held = new Map<string, PaneRecord[]>()
    for (const pane of panes) {
      // Every pane here came out of a group above, so the fallback only makes
      // this total: a pane that is its own tab is exactly what an ungrouped
      // session already is.
      const groupId = groupOf.get(pane.id) ?? pane.id
      const already = held.get(groupId)
      if (already) already.push(pane)
      else held.set(groupId, [pane])
    }
    const tabRows = [...held].map(([groupId, groupPanes]) =>
      tabRowFor(
        { id: tabIdOfGroup(groupId), groupId },
        groupPanes.map((pane) => pane.id),
        savedByGroup.get(groupId),
      ),
    )

    // One descriptor per saved project, in saved order — so the write below can
    // take each resolved active tab from here rather than resolving twice.
    const real = await describeProjects(saved.projects, panes)

    const projects = withUnsorted(real, panes)

    // Resolved after the append, so Unsorted can be the selected project: with
    // no real projects yet it is the only place a stray can be reached from.
    const activeProjectId =
      projects.find((project) => project.id === saved.activeProjectId)?.id ??
      projects[0]?.id ??
      null

    // Titles and colours are put back here because `panes` came out of
    // `manager.open()` above, which deals in tmux and carries neither.
    // Computed once, before the write, and used for both it and the reply:
    // writing the bare array would persist a stripped row over every saved
    // title and colour on every launch, and the renderer could not tell,
    // because it draws from the patched reply rather than from the file.
    // Nothing between `manager.open()` and here reads either: `held` and
    // `tabRows` key off `pane.id`, and `describeProjects` and `withUnsorted`
    // off `id` and `projectSlug`.
    const restored = attachSavedFields(panes, saved.panes)

    await store.write({
      version: 8,
      // Only real projects are persisted; the Unsorted row is synthetic.
      // Matched by id rather than by index: `describeProjects` returns one row
      // per project today, but adding a `filter` or a `continue` to it would
      // otherwise shift every project's active tab onto its neighbour, and
      // without `noUncheckedIndexedAccess` that would typecheck cleanly and
      // leave the suite green.
      projects: saved.projects.map((project) => {
        const described = real.find((candidate) => candidate.id === project.id)
        // Branching on the lookup rather than `?? project.activeTabId`: a
        // project with no live tab resolves to null *by design*, and coalescing
        // would read that as "not found" and keep the dead id on disk instead.
        return described ? { ...project, activeTabId: described.activeTabId } : project
      }),
      activeProjectId,
      panes: restored,
      // One row per tab live tmux still has, holding the saved axis and ratios
      // wherever a saved row still describes panes that came back. A tab whose
      // panes have all gone has no row here at all — dropped by having no
      // entry in `held` rather than by anything filtering it out.
      tabs: tabRows,
      notifications: saved.notifications,
    })

    // `tabs` rides along with `panes` rather than being dropped here as it
    // used to be (finding I5): `store.write` above just took the same
    // `tabRows`, and a caller laying out a split needs exactly what was
    // written, not a second `store.read()` to get it back. The same now goes
    // for `restored`, for the same reason.
    return { projects, panes: restored, tabs: tabRows, activeProjectId }
  })
}
