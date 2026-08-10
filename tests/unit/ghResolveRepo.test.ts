/**
 * What the issues column says when it cannot work out which repository it is
 * looking at. Real repositories on disk, like `gitOps.test.ts`'s own suite:
 * every case here fails inside `resolveRepo`, before `gh` is ever spawned, so
 * nothing in this file needs a GitHub CLI or a network.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../../src/main/git/sync'
import { listIssues, resolveRepo } from '../../src/main/gh/issues'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-gh-resolve-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A repository at `dir` whose `origin` is `url`, or none when it is null. */
async function repoWithOrigin(url: string | null): Promise<void> {
  await git(dir, ['init'])
  if (url !== null) await git(dir, ['remote', 'add', 'origin', url])
}

describe('resolveRepo', () => {
  it('hands back the remote it rejected', async () => {
    await repoWithOrigin('git@gitlab.com:team/thing.git')
    const resolved = await resolveRepo(dir)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe('not-github')
    expect(resolved.remote).toBe('git@gitlab.com:team/thing.git')
  })

  it('reports no remote at all separately from a rejected one', async () => {
    await repoWithOrigin(null)
    const resolved = await resolveRepo(dir)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe('no-remote')
    expect(resolved.remote).toBeUndefined()
  })
})

describe('the not-github message', () => {
  it('names the remote it rejected', async () => {
    // The host rule is an allowlist, so this is exactly the user whose
    // `git remote -v` says GitHub and whose column said it does not: naming
    // the URL is what turns a contradiction into a visible rule.
    await repoWithOrigin('git@github.corp.example:team/thing.git')
    const result = await listIssues(dir, 'open')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-github')
    expect(result.message).toContain('git@github.corp.example:team/thing.git')
  })

  it('names an https remote the same way', async () => {
    await repoWithOrigin('https://gitlab.com/team/thing.git')
    const result = await listIssues(dir, 'open')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('https://gitlab.com/team/thing.git')
  })

  it('leaves every other reason with the message it always had', async () => {
    await repoWithOrigin(null)
    const noRemote = await listIssues(dir, 'open')
    expect(noRemote.ok).toBe(false)
    if (noRemote.ok) return
    expect(noRemote.message).toBe('This repository has no origin remote.')

    const outside = await mkdtemp(join(tmpdir(), 'pterm-gh-notrepo-'))
    try {
      const noRepo = await listIssues(outside, 'open')
      expect(noRepo.ok).toBe(false)
      if (noRepo.ok) return
      expect(noRepo.reason).toBe('no-repo')
      expect(noRepo.message).toBe('This project is not inside a git repository.')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
