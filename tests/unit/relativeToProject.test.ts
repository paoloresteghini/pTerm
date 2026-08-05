import { describe, it, expect } from 'vitest'
import { relativeToProject } from '../../src/renderer/lib/relativeToProject'

// The conversion `App.tsx` makes between what a pane row stores (an absolute
// `filePath`) and what `fsRead` takes (a path relative to the project). It
// lives in a module of its own for the reason `treeState` does: vitest runs
// `environment: 'node'`, so a component cannot be mounted here, and this
// arithmetic would otherwise be reachable only from e2e.
describe('relativeToProject', () => {
  it('answers the path below the project root', () => {
    expect(relativeToProject('/tmp/demo', '/tmp/demo/src/app.ts')).toBe('src/app.ts')
  })

  it('answers a file directly in the root', () => {
    expect(relativeToProject('/tmp/demo', '/tmp/demo/README.md')).toBe('README.md')
  })

  it('answers null for the project root itself', () => {
    // Not `''`: the root is a directory, not a file inside the project, and an
    // empty relative path would ask `fsRead` to read the directory.
    //
    // This answer is over-determined, and the assertion is kept for the
    // behaviour rather than for the branch. Measured 2026-08-04: deleting the
    // `filePath === root` line still passes this, because the prefix test after
    // it answers null too. So a mutation of that one line staying green here is
    // the expected result, not a dead test. What must never change is the
    // answer.
    expect(relativeToProject('/tmp/demo', '/tmp/demo')).toBeNull()
  })

  it('answers null for a path outside the project', () => {
    expect(relativeToProject('/tmp/demo', '/tmp/other/app.ts')).toBeNull()
  })

  it('answers null for a sibling whose name starts with the root', () => {
    // The trailing-separator point `isInside` makes in `src/main/files/tree.ts`,
    // from the other side of the wire: a plain `startsWith(root)` would call
    // this a child and hand `fsRead` a relative path spelled `2/app.ts` (the
    // slice is `root.length + 1`, so it eats the `-` as if it were the
    // separator, which is what makes the wrong answer look like a plausible
    // one). Measured in node 2026-08-04.
    expect(relativeToProject('/tmp/demo', '/tmp/demo-2/app.ts')).toBeNull()
  })

  it('answers null for a path that is a prefix of the root', () => {
    expect(relativeToProject('/tmp/demo/src', '/tmp/demo')).toBeNull()
  })

  it('tolerates a trailing separator on the root', () => {
    // `config.json` is hand-editable and `/tmp/demo/` is the same project as
    // `/tmp/demo`. Without this the whole pane would say the file is gone.
    expect(relativeToProject('/tmp/demo/', '/tmp/demo/src/app.ts')).toBe('src/app.ts')
    expect(relativeToProject('/tmp/demo///', '/tmp/demo/src/app.ts')).toBe('src/app.ts')
  })

  it('answers null for a file path that is only the root plus a separator', () => {
    expect(relativeToProject('/tmp/demo', '/tmp/demo/')).toBeNull()
  })

  it('answers null when either side is not absolute', () => {
    // The empty `cwd` is the case that matters, and it is the one a synthetic
    // project could carry: without the guard's `cwd` half the root becomes `''`
    // and every absolute path reads as a child of it. These two discriminate.
    expect(relativeToProject('', '/tmp/demo/app.ts')).toBeNull()
    expect(relativeToProject('demo', '/tmp/demo/app.ts')).toBeNull()
    // The third does not, and is kept for the behaviour like the root case
    // above. Measured 2026-08-04: deleting the guard's `filePath` half still
    // passes this, because a relative path cannot start with an absolute root.
    expect(relativeToProject('/tmp/demo', 'src/app.ts')).toBeNull()
  })

  it('does not resolve dot segments, which main refuses on the way back', () => {
    // Deliberate: this is not the containment check, and re-deriving one here
    // would be a second copy of a rule that must not drift. `resolveInside`
    // re-resolves this against the project root and answers null.
    expect(relativeToProject('/tmp/demo', '/tmp/demo/../etc/passwd')).toBe('../etc/passwd')
  })
})
