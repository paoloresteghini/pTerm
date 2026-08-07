import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchFromHead, readBranch } from '../../src/main/git/branch'

describe('branchFromHead', () => {
  it('takes the name after refs/heads/', () => {
    expect(branchFromHead('ref: refs/heads/main\n')).toBe('main')
  })

  it('keeps the slashes inside a branch name', () => {
    // The whole remainder, not the last segment: `feature/foo` is one branch
    // and `foo` is a different one.
    expect(branchFromHead('ref: refs/heads/feature/nested/name\n')).toBe('feature/nested/name')
  })

  it('abbreviates a detached HEAD to seven characters', () => {
    expect(branchFromHead('9fceb02d4a1e5b3c6d7e8f90a1b2c3d4e5f60718\n')).toBe('9fceb02')
  })

  it('refuses a symbolic ref that is not a branch', () => {
    // A bar labelled with the current branch has nothing honest to show for a
    // ref outside refs/heads/.
    expect(branchFromHead('ref: refs/remotes/origin/main\n')).toBeNull()
  })

  it('refuses text that is neither', () => {
    expect(branchFromHead('')).toBeNull()
    expect(branchFromHead('not a head file')).toBeNull()
    // Too short to be an object id, so not a detached HEAD either.
    expect(branchFromHead('9fceb0')).toBeNull()
  })
})

describe('readBranch', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pterm-gitbranch-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads HEAD from an ordinary checkout', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/master\n')
    expect(await readBranch(root)).toBe('master')
  })

  it('walks up from a subdirectory', async () => {
    // A project's cwd is wherever the user pointed it, which is often not the
    // repository root.
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/master\n')
    const deep = join(root, 'src', 'renderer')
    await mkdir(deep, { recursive: true })
    expect(await readBranch(deep)).toBe('master')
  })

  it('follows a .git file to the directory it names', async () => {
    // The linked-worktree shape: `.git` is a file, and its HEAD is the one that
    // says what that worktree is on, not the main checkout's.
    const real = join(root, 'store', 'worktrees', 'wt')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'HEAD'), 'ref: refs/heads/side-branch\n')
    const work = join(root, 'work')
    await mkdir(work, { recursive: true })
    await writeFile(join(work, '.git'), `gitdir: ${real}\n`)
    expect(await readBranch(work)).toBe('side-branch')
  })

  it('resolves a relative gitdir against the file that holds it', async () => {
    const work = join(root, 'work')
    const real = join(root, 'elsewhere')
    await mkdir(work, { recursive: true })
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'HEAD'), 'ref: refs/heads/relative\n')
    await writeFile(join(work, '.git'), 'gitdir: ../elsewhere\n')
    expect(await readBranch(work)).toBe('relative')
  })

  it('returns null outside a repository', async () => {
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    // Guards against the walk running past the temp dir into a real repository
    // higher up the filesystem, which would make this pass for the wrong reason
    // on a machine whose /tmp happened to sit inside one.
    expect(await readBranch(plain)).toBeNull()
  })

  it('returns null when the repository has no HEAD to read', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    expect(await readBranch(root)).toBeNull()
  })
})
