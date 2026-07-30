import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTmuxBin } from '../../src/main/tmux/resolve'

let dir: string
let fallbackDir: string

/** A real executable file named `tmux`, so the X_OK check has something to find. */
async function writeFakeTmux(inDir: string): Promise<string> {
  const bin = join(inDir, 'tmux')
  await writeFile(bin, '#!/bin/sh\necho "tmux 3.5a"\n', 'utf8')
  await chmod(bin, 0o755)
  return bin
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-resolve-path-'))
  fallbackDir = await mkdtemp(join(tmpdir(), 'prcli-resolve-fallback-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(fallbackDir, { recursive: true, force: true })
})

describe('resolveTmuxBin', () => {
  it('finds tmux on PATH', async () => {
    const bin = await writeFakeTmux(dir)
    expect(resolveTmuxBin({ PATH: dir }, [])).toBe(bin)
  })

  it('falls back to a known install dir when PATH has no tmux', async () => {
    const bin = await writeFakeTmux(fallbackDir)
    // This is the Finder/Dock case: launchd's PATH, Homebrew nowhere in it.
    expect(resolveTmuxBin({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, [fallbackDir])).toBe(bin)
  })

  it('prefers PATH over the fallback dirs', async () => {
    const onPath = await writeFakeTmux(dir)
    await writeFakeTmux(fallbackDir)
    expect(resolveTmuxBin({ PATH: dir }, [fallbackDir])).toBe(onPath)
  })

  it('honours PRCLI_TMUX_BIN above everything else', async () => {
    await writeFakeTmux(dir)
    expect(resolveTmuxBin({ PATH: dir, PRCLI_TMUX_BIN: '/custom/tmux' }, [fallbackDir]))
      .toBe('/custom/tmux')
  })

  it('ignores a non-executable file named tmux', async () => {
    await writeFile(join(dir, 'tmux'), 'not executable', 'utf8')
    await chmod(join(dir, 'tmux'), 0o644)
    expect(resolveTmuxBin({ PATH: dir }, [])).toBe('tmux')
  })

  it('ignores relative PATH entries', async () => {
    expect(resolveTmuxBin({ PATH: 'relative/bin' }, [])).toBe('tmux')
  })

  it('survives an absent PATH', () => {
    expect(resolveTmuxBin({}, [])).toBe('tmux')
  })

  it('returns the bare name when tmux is nowhere, so the adapter can report it', () => {
    expect(resolveTmuxBin({ PATH: '/usr/bin:/bin' }, [fallbackDir])).toBe('tmux')
  })
})
