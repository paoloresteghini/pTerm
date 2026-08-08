/**
 * Where a rename or a create is allowed to land.
 *
 * The renderer names a file by `(projectId, relPath)` and never by an absolute
 * path, so these functions are the whole boundary for the mutating half of the
 * file tree: everything they refuse is something the app cannot be made to
 * write. `resolveInside` in `tree.ts` already guards the relative path; what is
 * added here is the NAME, which is new user input that must not be able to
 * move a file somewhere else.
 */
import { describe, it, expect } from 'vitest'
import { renameTarget, createTarget, pathsFor } from '../../src/main/files/ops'

const ROOT = '/tmp/project'

describe('renameTarget', () => {
  it('renames within the same directory', () => {
    expect(renameTarget(ROOT, 'src/a.ts', 'b.ts')).toEqual({
      from: '/tmp/project/src/a.ts',
      to: '/tmp/project/src/b.ts',
    })
  })

  it('renames a file at the project root', () => {
    expect(renameTarget(ROOT, 'a.ts', 'b.ts')).toEqual({
      from: '/tmp/project/a.ts',
      to: '/tmp/project/b.ts',
    })
  })

  /*
   * A separator in the name would make a rename a MOVE, which the menu does
   * not offer and which is the shape every escape below takes. Refused rather
   * than sanitised: a caller asking to move a file is asking for something
   * this function does not do, and quietly renaming it to `a_b` instead would
   * be worse than declining.
   */
  it.each(['../b.ts', 'sub/b.ts', '/abs.ts', '..', '.', '', 'a/../../b.ts'])(
    'refuses the name %j',
    (name) => {
      expect(renameTarget(ROOT, 'src/a.ts', name)).toBeNull()
    },
  )

  it('refuses a name containing a null byte', () => {
    expect(renameTarget(ROOT, 'src/a.ts', `b${String.fromCharCode(0)}.ts`)).toBeNull()
  })

  // The relative path is guarded by `resolveInside`, and that guard has to keep
  // applying here: a traversal in the path is as good as one in the name.
  it.each(['../outside.ts', '/etc/passwd', 'src/../../outside.ts'])(
    'refuses the path %j',
    (relPath) => {
      expect(renameTarget(ROOT, relPath, 'b.ts')).toBeNull()
    },
  )

  it('allows a name that merely contains dots', () => {
    expect(renameTarget(ROOT, 'a.ts', 'b.test.ts')?.to).toBe('/tmp/project/b.test.ts')
  })

  it('allows a dotfile name', () => {
    expect(renameTarget(ROOT, 'a.ts', '.env')?.to).toBe('/tmp/project/.env')
  })
})

describe('createTarget', () => {
  it('creates inside the named directory', () => {
    expect(createTarget(ROOT, 'src', 'new.ts')).toBe('/tmp/project/src/new.ts')
  })

  it("creates at the project root for an empty directory path", () => {
    expect(createTarget(ROOT, '', 'new.ts')).toBe('/tmp/project/new.ts')
  })

  it.each(['../b.ts', 'sub/b.ts', '/abs.ts', '..', '.', ''])('refuses the name %j', (name) => {
    expect(createTarget(ROOT, 'src', name)).toBeNull()
  })

  it.each(['../outside', '/etc'])('refuses the directory %j', (dir) => {
    expect(createTarget(ROOT, dir, 'new.ts')).toBeNull()
  })
})

describe('pathsFor', () => {
  it('gives both the absolute and the project-relative path', () => {
    expect(pathsFor(ROOT, 'src/a.ts')).toEqual({
      absolute: '/tmp/project/src/a.ts',
      relative: 'src/a.ts',
    })
  })

  // The relative path is recomputed from the resolved absolute one rather than
  // echoed back, so a path written as `src/./a.ts` copies as `src/a.ts` and a
  // caller cannot round-trip an unnormalised string through the clipboard.
  it('normalises the relative path it reports', () => {
    expect(pathsFor(ROOT, 'src/./a.ts')?.relative).toBe('src/a.ts')
  })

  it.each(['../outside.ts', '/etc/passwd'])('refuses %j', (relPath) => {
    expect(pathsFor(ROOT, relPath)).toBeNull()
  })
})
