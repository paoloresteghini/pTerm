import type { SessionManager, TabRecord } from '../sessions/manager'
import type { ConfigStore } from '../state/store'
// One definition, shared with the renderer — `TabDescriptor` and `TabRecord`
// are the same shape, and duplicating the type here would let them drift.
import type { RestoreResult } from '../../shared/ipc'

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

  const tabs = ordered.map((record) =>
    manager.open({
      id: record.id,
      projectSlug: record.projectSlug,
      cwd: record.cwd,
      command: record.command,
      tmuxSession: record.tmuxSession,
    }),
  )

  const activeTabId =
    tabs.find((candidate) => candidate.id === saved.activeTabId)?.id ?? tabs[0]?.id ?? null

  await store.write({ version: 2, activeTabId, tabs })
  return { tabs, activeTabId }
}
