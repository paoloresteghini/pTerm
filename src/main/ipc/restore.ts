import { homedir } from 'node:os'
import type { SessionManager, TabRecord } from '../sessions/manager'
import type { ConfigStore, ProjectRecord } from '../state/store'
import { readManifest, mergePresets } from '../projects/manifest'
import { isDirectory } from '../fsutil'
// One definition, shared with the renderer — `TabDescriptor` and `TabRecord`
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
 * Reconcile the saved workspace against what tmux actually has.
 *
 * Live tmux sessions decide what exists; config supplies display order, which
 * project is selected and which tab is active inside each. Deriving existence
 * from config instead is what made a session the app had lost track of
 * unreachable from the UI.
 *
 * A tab belongs to the project whose slug its session name carries. Nothing
 * stores that association, so it cannot go stale, and Unsorted is a definition
 * — tabs matching no project — rather than a list anyone maintains.
 *
 * The whole reconcile runs inside the caller's config write queue: it reads and
 * then writes, and an interleaved write from `open` or an exit would otherwise
 * be lost.
 */
export async function restoreWorkspace(
  manager: SessionManager,
  store: ConfigStore,
  serialise: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<RestoreResult> {
  return serialise(async () => {
    const saved = await store.read()

    // Any client we still hold is stale here by definition: a restore means
    // the renderer that owned it is gone. `findOrphans` excludes sessions we
    // have attached, so without this a second restore in one app lifetime — a
    // ⌘R, a renderer crash — sees nothing, returns an empty workspace and
    // writes it over config, stranding every session the user had open.
    // Detaching first also makes tmux redraw each pane into the fresh xterm.
    manager.detachAll()
    const orphans = await manager.findOrphans()
    const byId = new Map(orphans.map((orphan) => [orphan.id, orphan]))

    // Saved order first, skipping rows whose session is gone.
    const ordered: TabRecord[] = []
    for (const row of saved.tabs) {
      const orphan = byId.get(row.id)
      if (!orphan) continue
      byId.delete(row.id)
      // The saved row carries the real cwd, command and type; the orphan's
      // are synthesised and, for type, always 'shell' — using them here would
      // downgrade a claude or preset tab back to plain shell on every restore.
      ordered.push({ ...orphan, cwd: row.cwd, command: row.command, type: row.type })
    }
    // Then anything tmux has that config did not know about.
    ordered.push(...byId.values())

    const tabs: TabDescriptor[] = []
    for (const record of ordered) {
      try {
        tabs.push(
          manager.open({
            id: record.id,
            projectSlug: record.projectSlug,
            cwd: record.cwd,
            command: record.command,
            tmuxSession: record.tmuxSession,
            type: record.type,
          }),
        )
      } catch {
        // One session that will not attach must not cost the user the ones
        // that did — with twelve tabs, rejecting the whole restore would leave
        // every other session attached and invisible. tmux still has this one,
        // so the next restore finds it again and tries afresh.
        continue
      }
    }

    // One descriptor per saved project, in saved order — so the write below can
    // take each resolved active tab from here rather than resolving twice.
    const real = await describeProjects(saved.projects, tabs)

    const projects = withUnsorted(real, tabs)

    // Resolved after the append, so Unsorted can be the selected project: with
    // no real projects yet it is the only place a stray can be reached from.
    const activeProjectId =
      projects.find((project) => project.id === saved.activeProjectId)?.id ??
      projects[0]?.id ??
      null

    await store.write({
      version: 4,
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
      tabs,
      notifications: saved.notifications,
    })

    return { projects, tabs, activeProjectId }
  })
}
