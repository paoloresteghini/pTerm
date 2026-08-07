/**
 * Which directories of a project's tree are expanded, and where that is kept.
 *
 * `localStorage`, per project, following this app's split: view state goes in
 * `localStorage`, project data goes in a file under `configRoot()`, and
 * neither goes in `config.json`. Which folders are open is view state.
 *
 * The rule used to be cited here as `NotesPanel.tsx`'s precedent. That file no
 * longer demonstrates it: every column's collapse flag moved into `App.tsx`
 * when the View menu needed to read them. The split itself is unchanged, so
 * only the example moved.
 *
 * Here rather than inside `FileTree.tsx` so it can be tested at all. vitest
 * runs `environment: 'node'`, so a component is only reachable from Playwright,
 * and a parse that throws inside a render would be found by a user rather than
 * by a test.
 */
const KEY = 'pterm:treeExpanded:'

/**
 * The open directories of `projectId`, as relative paths.
 *
 * Anything unreadable is "nothing open". `localStorage` is a text file by
 * another name: a truncated write or a hand edit must not throw inside a
 * render, and an empty tree is a recoverable state the user can see and fix by
 * clicking, whereas a thrown error in render is a blank sidebar.
 */
export function readExpanded(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(KEY + projectId)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

/** Replace the open set for `projectId`. */
export function writeExpanded(projectId: string, paths: Set<string>): void {
  try {
    localStorage.setItem(KEY + projectId, JSON.stringify([...paths]))
  } catch {
    // A quota or a disabled store costs the user their expansion state on the
    // next launch and nothing else. It must not take the click with it.
  }
}

/**
 * `paths` with `relPath` flipped.
 *
 * A new Set rather than a mutation: this feeds React state, and a mutated Set
 * is the same reference, so nothing would re-render.
 */
export function toggled(paths: Set<string>, relPath: string): Set<string> {
  const next = new Set(paths)
  if (!next.delete(relPath)) next.add(relPath)
  return next
}
