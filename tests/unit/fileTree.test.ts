// Mutation check results (Step 5):
//
// Mutation 1: resolveInside's containment check.
// Changed: return isInside(root, target) ? target : null   to:   return target
// Observed: 2 tests fail, "refuses to climb out with .." and
// "refuses a sibling whose name extends the root". The test "refuses an
// absolute path" passes because isAbsolute is an independent check earlier.
//
// Mutation 2: listDir's realpath containment check.
// Changed: if (!isInside(realRoot, realTarget)) return []   to:   commented out
// Observed: 2 tests fail, "returns empty list when a top-level symlink points
// outside" and "returns empty list when a nested symlink points outside".
//
// Both guards are load-bearing. Tests observed on 2026-08-04.
//
// Mutation 3: readFileInside's realpath containment check.
// Changed: if (!isInside(realRoot, realTarget)) return null   to:   if (false) return null
// Observed: 1 test fails, "refuses to read through a symlink pointing
// outside". The tests "refuses to read outside the root" (both the ../..
// and the absolute-path case) pass unchanged, because resolveInside's own
// checks catch those before this guard is ever reached; only the symlink
// case depends on this half. Tests observed on 2026-08-04.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInside, listDir, readFileInside } from '../../src/main/files/tree'

let root: string
let outside: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'prcli-tree-root-'))
  outside = await mkdtemp(join(tmpdir(), 'prcli-tree-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'no')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'dirA'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'README.md'), '#')
  await writeFile(join(root, '.env'), 'KEY=1')
  await writeFile(join(root, 'app.ts'), '')
  await writeFile(join(root, 'src', 'nested.ts'), 'const x = 1\n')
  await symlink(outside, join(root, 'escape'))
  await symlink(outside, join(root, 'dirA', 'link'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('resolveInside', () => {
  it('resolves a plain relative path under the root', () => {
    expect(resolveInside('/a/b', 'src')).toBe('/a/b/src')
  })

  it('resolves the root itself from an empty path', () => {
    expect(resolveInside('/a/b', '')).toBe('/a/b')
  })

  // The reason this function exists. The renderer is web content, and an IPC
  // channel that lists a directory is a directory-listing primitive for
  // anything that reaches it.
  it('refuses to climb out with ..', () => {
    expect(resolveInside('/a/b', '../c')).toBeNull()
    expect(resolveInside('/a/b', 'src/../../c')).toBeNull()
    expect(resolveInside('/a/b', '../../../../etc')).toBeNull()
  })

  it('refuses an absolute path', () => {
    expect(resolveInside('/a/b', '/etc')).toBeNull()
    expect(resolveInside('/a/b', '/a/b/src')).toBeNull()
  })

  // A prefix match on the string alone would accept this: '/a/bb' starts with
  // '/a/b'. The separator is what makes it a containment check.
  it('refuses a sibling whose name extends the root', () => {
    expect(resolveInside('/a/b', '../bb')).toBeNull()
  })

  // IPC does not enforce the type it declares. Before the `typeof` guard,
  // each of these threw a `TypeError` out of `isAbsolute` instead of
  // returning null: `listDir(root, undefined | null | 42 | {} | ['sub'])`,
  // verified against the pre-fix module on 2026-08-04.
  it('refuses a relPath that is not a string', () => {
    expect(resolveInside('/a/b', undefined as unknown as string)).toBeNull()
    expect(resolveInside('/a/b', null as unknown as string)).toBeNull()
    expect(resolveInside('/a/b', 42 as unknown as string)).toBeNull()
    expect(resolveInside('/a/b', {} as unknown as string)).toBeNull()
    expect(resolveInside('/a/b', ['sub'] as unknown as string)).toBeNull()
  })

  // `config.json` is hand-editable and a trailing separator on `cwd` is easy
  // to introduce by hand. Before `resolve(root)` ran once up front, this
  // returned null: `root + '/' + sep` never matches `resolve(root, relPath)`,
  // which normalises the trailing slash away. Verified against the pre-fix
  // module on 2026-08-04.
  it('normalises a trailing slash on root', () => {
    expect(resolveInside('/a/b/', 'src')).toBe('/a/b/src')
  })
})

describe('listDir', () => {
  // The file order is `localeCompare`'s, not ASCII's, and it is worth reading
  // twice before "correcting" it: `README.md` sorts LAST, after `escape`,
  // because localeCompare is case-insensitive at the primary level. Plain
  // `sort()` would give ['.env', 'README.md', 'app.ts', 'escape']. Verified in
  // node on 2026-08-04, not assumed.
  //
  // `escape` is the symlink the fixture creates. It appears among the FILES
  // because it points outside the project, which is the next test's subject.
  it('lists directories first, then files, each alphabetical', async () => {
    const entries = await listDir(root, '')
    expect(entries.map((entry) => entry.name)).toEqual([
      'dirA',
      'docs',
      'src',
      '.env',
      'app.ts',
      'escape',
      'README.md',
    ])
    expect(entries.filter((entry) => entry.dir).map((entry) => entry.name)).toEqual(['dirA', 'docs', 'src'])
  })

  // Hidden by name, at any depth. Dotfiles in general are NOT hidden: seeing
  // .env is a reason to have a file tree.
  it('hides .git and node_modules and nothing else', async () => {
    const names = (await listDir(root, '')).map((entry) => entry.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    expect(names).toContain('.env')
  })

  // A symlink out of the project is the traversal `..` cannot express. It is
  // reported as a leaf rather than a directory, so nothing can expand through
  // it, and `resolveInside` alone would not have caught it.
  it('does not offer a symlink pointing outside the project as a directory', async () => {
    const entry = (await listDir(root, '')).find((candidate) => candidate.name === 'escape')
    expect(entry).toBeDefined()
    expect(entry?.dir).toBe(false)
  })

  it('resolves an unreadable or missing directory to an empty list', async () => {
    await expect(listDir(root, 'nope')).resolves.toEqual([])
  })

  // The guard, reached through the real entry point rather than only in
  // isolation above.
  it('resolves a path outside the root to an empty list', async () => {
    await expect(listDir(root, '../..')).resolves.toEqual([])
  })

  // A symlink to a directory outside the project, when traversed directly,
  // must not expose that directory's contents. The symlink itself appears in
  // the parent listing with dir: false; requesting it as a path must return
  // empty, not follow through.
  it('returns empty list when a top-level symlink points outside', async () => {
    await expect(listDir(root, 'escape')).resolves.toEqual([])
  })

  // A symlink nested inside a directory must be caught the same way.
  it('returns empty list when a nested symlink points outside', async () => {
    await expect(listDir(root, 'dirA/link')).resolves.toEqual([])
  })

  // Before `resolveInside` normalised `root`, a trailing separator on it (as
  // a hand-edited `config.json` could carry) made `isInside` reject every
  // target under it, and this returned `[]` instead of the root's own
  // listing. Verified against the pre-fix module on 2026-08-04: with the fix
  // reverted, `listDir(root + '/', '')` came back `[]` while `listDir(root,
  // '')` still returned the 7 entries above.
  it('does not blank the tree when root has a trailing separator', async () => {
    const withSlash = await listDir(root + '/', '')
    expect(withSlash.length).toBeGreaterThan(0)
    expect(withSlash).toEqual(await listDir(root, ''))
  })
})

describe('readFileInside', () => {
  it('reads a file under the root', async () => {
    const found = await readFileInside(root, 'app.ts')
    expect(found?.text).toBe('')
    expect(typeof found?.mtimeMs).toBe('number')
  })

  it('reads a file in a subdirectory', async () => {
    const found = await readFileInside(root, 'src/nested.ts')
    expect(found?.text).toBe('const x = 1\n')
  })

  // The same boundary `listDir` has, reached through the other entry point.
  // A guard on one channel and not the other is not a guard.
  it('refuses to read outside the root', async () => {
    await expect(readFileInside(root, '../../etc/hosts')).resolves.toBeNull()
    await expect(readFileInside(root, '/etc/hosts')).resolves.toBeNull()
  })

  // The half `..` cannot express, which the listing side already covers.
  it('refuses to read through a symlink pointing outside', async () => {
    await expect(readFileInside(root, 'escape/secret.txt')).resolves.toBeNull()
  })

  it('resolves a missing file to null rather than throwing', async () => {
    await expect(readFileInside(root, 'nope.ts')).resolves.toBeNull()
  })

  // A directory is not a file. Reading one must not throw out of a channel
  // whose caller is a React render.
  it('resolves a directory to null rather than throwing', async () => {
    await expect(readFileInside(root, 'src')).resolves.toBeNull()
  })

  it('refuses a relPath that is not a string', async () => {
    await expect(readFileInside(root, 42 as unknown as string)).resolves.toBeNull()
  })
})
