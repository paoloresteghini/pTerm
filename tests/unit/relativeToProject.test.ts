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
    expect(relativeToProject('/tmp/demo', '/tmp/demo')).toBeNull()
  })

  it('answers null for a path outside the project', () => {
    expect(relativeToProject('/tmp/demo', '/tmp/other/app.ts')).toBeNull()
  })

  it('answers null for a sibling whose name starts with the root', () => {
    // The trailing-separator point `isInside` makes in `src/main/files/tree.ts`,
    // from the other side of the wire: a plain `startsWith` would call this a
    // child and hand `fsRead` a relative path spelled `-2/app.ts`.
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
    // The empty `cwd` a synthetic project could carry is the case that matters:
    // without the guard every absolute path would read as a child of it.
    expect(relativeToProject('', '/tmp/demo/app.ts')).toBeNull()
    expect(relativeToProject('demo', '/tmp/demo/app.ts')).toBeNull()
    expect(relativeToProject('/tmp/demo', 'src/app.ts')).toBeNull()
  })

  it('does not resolve dot segments, which main refuses on the way back', () => {
    // Deliberate: this is not the containment check, and re-deriving one here
    // would be a second copy of a rule that must not drift. `resolveInside`
    // re-resolves this against the project root and answers null.
    expect(relativeToProject('/tmp/demo', '/tmp/demo/../etc/passwd')).toBe('../etc/passwd')
  })
})
