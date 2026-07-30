import type { SessionManager, TabRecord } from '../sessions/manager'
import type { ConfigStore } from '../state/store'
// One definition, shared with the renderer — `TabDescriptor` and `TabRecord`
// are the same shape, and duplicating the type here would let them drift.
import type { RestoreResult, TabDescriptor } from '../../shared/ipc'

/**
 * Reconcile the saved workspace against what tmux actually has.
 *
 * Live tmux sessions decide what exists; config only supplies display order
 * and which tab was active. Deriving existence from config instead is what
 * made a session the app had lost track of unreachable from the UI — and a
 * crash, an external `tmux kill-session`, or a second instance can all leave
 * one behind.
 */
export async function restoreWorkspace(
  manager: SessionManager,
  store: ConfigStore,
): Promise<RestoreResult> {
  const saved = await store.read()

  // Any client we still hold is stale here by definition: a restore means the
  // renderer that owned it is gone. `findOrphans` excludes sessions we have
  // attached, so without this a second restore in one app lifetime — a ⌘R, a
  // renderer crash — sees nothing, returns an empty workspace and writes it
  // over config, stranding every session the user had open. Detaching first
  // also makes tmux redraw each pane into the fresh xterm.
  manager.detachAll()
  const orphans = await manager.findOrphans()
  const byId = new Map(orphans.map((orphan) => [orphan.id, orphan]))

  // Saved order first, skipping rows whose session is gone.
  const ordered: TabRecord[] = []
  for (const row of saved.tabs) {
    const orphan = byId.get(row.id)
    if (!orphan) continue
    byId.delete(row.id)
    // The saved row carries the real cwd; the orphan's is synthesised.
    ordered.push({ ...orphan, cwd: row.cwd, command: row.command })
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
        }),
      )
    } catch {
      // One session that will not attach must not cost the user the ones that
      // did — with twelve tabs, rejecting the whole restore would leave every
      // other session attached and invisible. tmux still has this one, so the
      // next restore finds it again and tries afresh.
      continue
    }
  }

  // v3 replaced the global active tab with one per project. Task 7 resolves
  // these per project properly; until then, honouring whichever project claims
  // a live tab is enough to keep the behaviour from regressing.
  const activeTabId =
    tabs.find((candidate) =>
      saved.projects.some((project) => project.activeTabId === candidate.id),
    )?.id ?? tabs[0]?.id ?? null

  await store.write({ ...saved, version: 3, tabs })
  return { tabs, activeTabId }
}
