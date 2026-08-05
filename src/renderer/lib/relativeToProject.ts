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
  // Both must be absolute, and the two halves of that are not equally load
  // bearing. Measured 2026-08-04 by re-implementing this function three ways
  // and running every input in its test file through all three:
  //
  // - The `cwd` half decides answers. With `cwd: ''`, which is the shape a
  //   synthetic project could carry, `root` below becomes `''` and every
  //   absolute path reads as a child of it.
  // - The `filePath` half decides none. By the time it is reached `root` is
  //   absolute, so a relative `filePath` can never start with it and the
  //   prefix test below answers null on its own.
  //
  // Kept as one condition anyway: the rule is "both sides are absolute paths",
  // and half a stated rule is harder to reason about than a redundant clause.
  // It is defence, not mechanism, which is what this comment exists to say.
  if (!cwd.startsWith('/') || !filePath.startsWith('/')) return null
  const root = cwd.replace(/\/+$/, '')
  // The project root itself is not a file inside the project.
  //
  // Defence again, measured the same way and on the same date: deleting this
  // line changes no answer, because `/tmp/demo` does not start with
  // `/tmp/demo/` and the prefix test below already returns null. Kept because
  // "the root is not a file in it" is worth stating where someone can read it,
  // rather than leaving it to emerge from an off-by-one in a `startsWith`.
  if (filePath === root) return null
  if (!filePath.startsWith(`${root}/`)) return null
  const rest = filePath.slice(root.length + 1)
  // `/a/b/` against a root of `/a/b`: past the prefix test with nothing left.
  return rest === '' ? null : rest
}
