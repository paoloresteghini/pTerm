// Mutation check (Step 5): When the realpath containment check in listDir is
// removed (if (!isInside(realRoot, realTarget)) return []), 2 tests fail:
// "returns empty list when a top-level symlink points outside" and
// "returns empty list when a nested symlink points outside". Observed on 2026-08-04.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInside, listDir } from '../../src/main/files/tree'

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
})
