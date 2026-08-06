import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, parseCounts, describeFailure, readCounts, syncBranch } from '../../src/main/git/sync'

describe('parseCounts', () => {
  it('reads behind then ahead', () => {
    // `--left-right --count @{u}...HEAD` puts the upstream on the left, so the
    // first number is what has yet to come down.
    expect(parseCounts('3\t1\n')).toEqual({ behind: 3, ahead: 1 })
  })

  it('reads a clean checkout', () => {
    expect(parseCounts('0\t0\n')).toEqual({ behind: 0, ahead: 0 })
  })

  it('refuses anything else', () => {
    // What git writes when there is no upstream goes to stderr, but an empty or
    // surprising stdout must not become a count of zero: "nothing waiting" and
    // "no answer" are different things in the bar.
    expect(parseCounts('')).toBeNull()
    expect(parseCounts('fatal: no upstream configured')).toBeNull()
    expect(parseCounts('3')).toBeNull()
    expect(parseCounts('3\t1\t9')).toBeNull()
  })
})

describe('describeFailure', () => {
  it('prefers gitfatal line over the progress above it', () => {
    // A failed `pull` writes the fetch's progress first, so the first line is
    // the remote's name and the reason is three lines down.
    const stderr = [
      'From /tmp/remote',
      ' * branch            main       -> FETCH_HEAD',
      'fatal: Not possible to fast-forward, aborting.',
    ].join('\n')
    expect(describeFailure(stderr, '')).toBe('fatal: Not possible to fast-forward, aborting.')
  })

  it('takes an error: line the same way', () => {
    expect(describeFailure('To /tmp/remote\nerror: failed to push some refs', '')).toBe(
      'error: failed to push some refs',
    )
  })

  it('falls back to the first non-empty line', () => {
    expect(describeFailure('\n\n  something went wrong  \n', '')).toBe('something went wrong')
  })

  it('reads stdout when stderr is silent', () => {
    expect(describeFailure('', 'everything up-to-date')).toBe('everything up-to-date')
  })

  it('always has something to say', () => {
    expect(describeFailure('', '')).toBe('git failed')
  })
})

/**
 * Real repositories on disk rather than a stubbed `git`. What is under test is
 * the agreement with git itself — which numbers come out of `rev-list` in which
 * order, and what `pull --ff-only` does to a diverged branch — and a stub would
 * only assert the agreement this file already assumes.
 */
describe('against real repositories', () => {
  let root: string
  let bare: string
  let work: string
  let other: string

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

  async function commit(cwd: string, name: string): Promise<string> {
    await writeFile(join(cwd, name), `${name}\n`)
    await run(cwd, ['add', name])
    await run(cwd, ['commit', '-m', name])
    return run(cwd, ['rev-parse', 'HEAD'])
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'prcli-gitsync-'))
    bare = join(root, 'remote.git')
    work = join(root, 'work')
    other = join(root, 'other')
    await run(root, ['init', '--bare', bare])
    await run(root, ['clone', bare, work])
    await commit(work, 'first')
    await run(work, ['push', '-u', 'origin', 'main'])
    // A second clone, so "someone else pushed" is a real push rather than a
    // hand-written ref.
    await run(root, ['clone', bare, other])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('counts nothing on a checkout level with its upstream', async () => {
    expect(await readCounts(work)).toEqual({ behind: 0, ahead: 0 })
  })

  it('counts a local commit as ahead', async () => {
    await commit(work, 'local')
    expect(await readCounts(work)).toEqual({ behind: 0, ahead: 1 })
  })

  it('does not see someone else push until something fetches', async () => {
    await commit(other, 'theirs')
    await run(other, ['push'])
    // The whole reason the bar's down count is only as fresh as the last sync:
    // the local remote-tracking ref has not moved, so there is nothing to count.
    expect(await readCounts(work)).toEqual({ behind: 0, ahead: 0 })
  })

  it('pushes what is ahead', async () => {
    const local = await commit(work, 'local')
    expect(await syncBranch(work)).toEqual({ ok: true })
    expect(await run(bare, ['rev-parse', 'main'])).toBe(local)
    expect(await readCounts(work)).toEqual({ behind: 0, ahead: 0 })
  })

  it('fast-forwards what is behind', async () => {
    const theirs = await commit(other, 'theirs')
    await run(other, ['push'])
    expect(await syncBranch(work)).toEqual({ ok: true })
    expect(await run(work, ['rev-parse', 'HEAD'])).toBe(theirs)
  })

  it('refuses a diverged branch and writes nothing', async () => {
    const theirs = await commit(other, 'theirs')
    await run(other, ['push'])
    const mine = await commit(work, 'mine')

    const result = await syncBranch(work)
    expect(result.ok).toBe(false)
    // git's own words, so the bar is not paraphrasing a thing it did not do.
    expect(result.ok === false && result.error).toMatch(/fast-forward/)

    // Nothing merged locally and nothing pushed: the user's commit is still the
    // tip here, and theirs is still the tip there.
    expect(await run(work, ['rev-parse', 'HEAD'])).toBe(mine)
    expect(await run(bare, ['rev-parse', 'main'])).toBe(theirs)
    // The fetch that ran first still counted, which is what lets the bar show
    // the divergence that the error is about.
    expect(await readCounts(work)).toEqual({ behind: 1, ahead: 1 })
  })

  it('has no counts for a branch with no upstream', async () => {
    await run(work, ['checkout', '-b', 'unpublished'])
    expect(await readCounts(work)).toBeNull()
  })

  it('has no counts outside a repository', async () => {
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    expect(await readCounts(plain)).toBeNull()
  })
})
