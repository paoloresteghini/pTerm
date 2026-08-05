/**
 * Where `filePath` sits inside `cwd`, or null when it does not sit there.
 *
 * A pane row stores an absolute `filePath` and `fsRead` takes a path relative
 * to the project, so something has to convert between the two. This is that
 * conversion, and it is out here rather than inline in the component that needs
 * it because vitest runs `environment: 'node'`: a React component cannot be
 * unit tested in this repo, and a path calculation only e2e can reach is the
 * shape of defect this codebase keeps being bitten by.
 *
 * String arithmetic, with no `node:path`: `nodeIntegration` is off for this
 * window and nothing under `src/renderer/` can resolve a node builtin. It is
 * the same constraint `tabLabel` hand-rolls its basename under.
 *
 * NOT a containment check, and must not be read as one. It answers null for the
 * paths it cannot express relatively, which happens to include ones outside the
 * project, but the guard that matters is main's: `resolveInside` re-resolves
 * whatever comes back from here against the project root and refuses anything
 * that leaves it. So a hand-edited `filePath` of `/a/b/../../etc/passwd` yields
 * `../../etc/passwd` here and is refused there, rather than being refused twice
 * by two copies of one rule that could drift apart.
 *
 * A root with a trailing separator is tolerated: `config.json` is hand-editable
 * and `/a/b/` names the same project as `/a/b`. The comparison adds the
 * separator back before testing, which is what keeps a sibling directory
 * (`/a/bb`) from reading as a child of `/a/b`, which is the same
 * trailing-separator point `isInside` makes in `src/main/files/tree.ts`.
 */
export function relativeToProject(cwd: string, filePath: string): string | null {
  // Both must be absolute. A relative root has no meaning to compare against,
  // and the empty `cwd` a synthetic project could carry would otherwise make
  // every absolute path look like a child of it.
  if (!cwd.startsWith('/') || !filePath.startsWith('/')) return null
  const root = cwd.replace(/\/+$/, '')
  // The project root itself is not a file inside the project, so an exact match
  // is null rather than an empty relative path, which `fsRead` would resolve
  // back to the directory and refuse anyway, less legibly.
  if (filePath === root) return null
  if (!filePath.startsWith(`${root}/`)) return null
  const rest = filePath.slice(root.length + 1)
  // `/a/b/` against a root of `/a/b`: past the prefix test with nothing left.
  return rest === '' ? null : rest
}
