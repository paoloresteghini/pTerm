import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ghBin } from '../../src/main/gh/run'
import { FALLBACK_DIRS } from '../../src/main/bin/resolve'

let dir: string
let fallbackDir: string

/** A real executable file named `gh`, so the X_OK check has something to find. */
async function writeFakeGh(inDir: string): Promise<string> {
  const bin = join(inDir, 'gh')
  await writeFile(bin, '#!/bin/sh\necho "gh version 2.97.0"\n', 'utf8')
  await chmod(bin, 0o755)
  return bin
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-ghbin-path-'))
  fallbackDir = await mkdtemp(join(tmpdir(), 'pterm-ghbin-fallback-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(fallbackDir, { recursive: true, force: true })
})

describe('ghBin', () => {
  it('resolves gh on PATH to an absolute path', async () => {
    const bin = await writeFakeGh(dir)
    expect(ghBin({ PATH: dir }, [])).toBe(bin)
  })

  it('falls back to a known install dir when PATH has no gh', async () => {
    const bin = await writeFakeGh(fallbackDir)
    // The bug this covers: a Finder or Dock launch inherits launchd's PATH,
    // which has no Homebrew in it, so the packaged app spawned a bare `gh`,
    // got ENOENT, and told a user with a working CLI to install one.
    expect(ghBin({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, [fallbackDir])).toBe(bin)
  })

  it('prefers PATH over the fallback dirs', async () => {
    const onPath = await writeFakeGh(dir)
    await writeFakeGh(fallbackDir)
    expect(ghBin({ PATH: dir }, [fallbackDir])).toBe(onPath)
  })

  it('honours PTERM_GH_BIN above everything else', async () => {
    await writeFakeGh(dir)
    expect(ghBin({ PATH: dir, PTERM_GH_BIN: '/custom/gh' }, [fallbackDir])).toBe('/custom/gh')
  })

  it('ignores a non-executable file named gh', async () => {
    await writeFile(join(dir, 'gh'), 'not executable', 'utf8')
    await chmod(join(dir, 'gh'), 0o644)
    expect(ghBin({ PATH: dir }, [])).toBe('gh')
  })

  it('ignores relative PATH entries', () => {
    expect(ghBin({ PATH: 'relative/bin' }, [])).toBe('gh')
  })

  it('survives an absent PATH', () => {
    expect(ghBin({}, [])).toBe('gh')
  })

  it('returns the bare name when gh is nowhere, so classify can report no-gh', () => {
    expect(ghBin({ PATH: '/usr/bin:/bin' }, [fallbackDir])).toBe('gh')
  })

  it('searches Homebrew first by default, which is the dir launchd omits', () => {
    expect(FALLBACK_DIRS[0]).toBe('/opt/homebrew/bin')
    expect(FALLBACK_DIRS).toContain('/usr/local/bin')
  })
})
