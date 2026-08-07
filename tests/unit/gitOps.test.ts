import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../../src/main/git/sync'
import { discard, safePaths } from '../../src/main/git/ops'

describe('safePaths', () => {
  it('keeps a plain repo-relative path', () => {
    expect(safePaths('/repo', ['src/a.ts'])).toEqual(['src/a.ts'])
  })

  it('drops a path that climbs out of the repository', () => {
    expect(safePaths('/repo', ['../outside.ts'])).toEqual([])
  })

  it('drops an absolute path', () => {
    expect(safePaths('/repo', ['/etc/passwd'])).toEqual([])
  })

  // `/repo` must not be read as a prefix of `/repository`.
  it('drops a sibling whose name starts with the root', () => {
    expect(safePaths('/repo', ['../repository/a.ts'])).toEqual([])
  })

  it('drops a path that climbs out and back in', () => {
    expect(safePaths('/repo', ['src/../../repo2/a.ts'])).toEqual([])
  })

  it('keeps a path that climbs and returns inside', () => {
    expect(safePaths('/repo', ['src/../a.ts'])).toEqual(['a.ts'])
  })

  it('drops an empty path', () => {
    expect(safePaths('/repo', [''])).toEqual([])
  })
})

/**
 * Real repositories on disk, like `gitSync.test.ts`'s own suite: what is
 * under test is `discard`'s agreement with a real `git status`, and a
 * stubbed one would only assert back the classification this file already
 * assumes.
 */
describe('discard, against real repositories', () => {
  let root: string

  /** git, with an identity, failing loudly: setup that half-worked is a lie. */
  async function run(cwd: string, args: string[]): Promise<string> {
    const result = await git(cwd, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ])
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
    }
    return result.stdout.trim()
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pterm-gitops-'))
    await run(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'one\n', 'utf8')
    await run(root, ['add', 'tracked.txt'])
    await run(root, ['commit', '-m', 'first'])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('restores a tracked file when the classification matches', async () => {
    await writeFile(join(root, 'tracked.txt'), 'two\n', 'utf8')
    const result = await discard(root, ['tracked.txt'], [])
    expect(result.ok).toBe(true)
    expect(await run(root, ['diff', '--name-only'])).toBe('')
  })

  it('deletes an untracked file when the classification matches', async () => {
    await writeFile(join(root, 'fresh.txt'), 'new\n', 'utf8')
    const result = await discard(root, ['fresh.txt'], ['fresh.txt'])
    expect(result.ok).toBe(true)
    expect(await run(root, ['status', '--porcelain'])).toBe('')
  })

  // The fix this review round is about: a path the dialog showed as
  // "restored" (absent from expectedUntracked) must not be silently
  // reclassified as untracked and deleted just because a fresh read now
  // disagrees. `git rm --cached` stands in for a concurrent session's own
  // discard or stage/unstage: the working file is untouched, but the index
  // entry that made the path "tracked" is gone.
  it('refuses the whole batch when a shown-as-tracked path is now untracked', async () => {
    await writeFile(join(root, 'tracked.txt'), 'two\n', 'utf8')
    await run(root, ['rm', '--cached', 'tracked.txt'])

    const result = await discard(root, ['tracked.txt'], [])

    expect(result.ok).toBe(false)
    // Neither branch ran: not restored (content is still what the working
    // tree had) and not deleted (the file still exists at all).
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('two\n')
  })

  // The mirror image: a path shown as "deleted from disk" (present in
  // expectedUntracked) that has since been staged must not be silently
  // restored instead of deleted, or vice versa read as still safe to act on.
  it('refuses the whole batch when a shown-as-untracked path is now tracked', async () => {
    await writeFile(join(root, 'fresh.txt'), 'new\n', 'utf8')
    await run(root, ['add', 'fresh.txt'])

    const result = await discard(root, ['fresh.txt'], ['fresh.txt'])

    expect(result.ok).toBe(false)
    expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('new\n')
  })

  it('surfaces a delete failure instead of swallowing it', async () => {
    await mkdir(join(root, 'locked'))
    await writeFile(join(root, 'locked', 'file.txt'), 'x\n', 'utf8')
    // Write permission on the containing directory, not the file, is what
    // unlink needs; removing it is what makes the delete fail without
    // touching whether the file itself can be read back to verify.
    await chmod(join(root, 'locked'), 0o555)
    try {
      const result = await discard(root, ['locked/file.txt'], ['locked/file.txt'])
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toContain('locked/file.txt')
    } finally {
      await chmod(join(root, 'locked'), 0o755)
    }
  })
})
