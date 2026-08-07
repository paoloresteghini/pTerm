export type DiffLineKind = 'header' | 'hunk' | 'add' | 'remove' | 'context'

/**
 * Classifies every line of a unified diff by role, for colouring.
 *
 * `+++`/`---` are only read as the file-header pair while OUTSIDE a hunk. A
 * REMOVED line can itself begin with `-` (a markdown rule, a SQL `-- `
 * comment) and a bare content-prefix match would misclassify it as a header
 * instead of a removal; tracking whether a `@@` hunk marker has been seen
 * since the last `diff --git` avoids that. `diff --git` resets the header
 * window because a combined diff of several files repeats the
 * header/hunk sequence once per file.
 */
export function classifyDiffLines(text: string): { line: string; kind: DiffLineKind }[] {
  let inHunk = false
  return text.split('\n').map((line) => {
    if (line.startsWith('diff --git')) {
      inHunk = false
      return { line, kind: 'header' as const }
    }
    if (line.startsWith('@@')) {
      inHunk = true
      return { line, kind: 'hunk' as const }
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) {
      return { line, kind: 'header' as const }
    }
    if (line.startsWith('+')) return { line, kind: 'add' as const }
    if (line.startsWith('-')) return { line, kind: 'remove' as const }
    return { line, kind: 'context' as const }
  })
}
