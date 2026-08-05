import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSkipped, skipPath, writeSkipped } from '../../src/main/update/store'

let dir: string
let previous: string | undefined

beforeEach(async () => {
  previous = process.env.PRCLI_CONFIG_DIR
  dir = await mkdtemp(join(tmpdir(), 'prcli-update-'))
  process.env.PRCLI_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.PRCLI_CONFIG_DIR
  else process.env.PRCLI_CONFIG_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

describe('skipPath', () => {
  // Read at call time, not at import time: a test that set the env var after
  // this module loaded would otherwise write into the developer's real ~/.prcli.
  it('resolves under PRCLI_CONFIG_DIR as it stands when called', () => {
    expect(skipPath()).toBe(join(dir, 'update.json'))
  })
})

describe('readSkipped', () => {
  it('answers null when nothing has been skipped', async () => {
    await expect(readSkipped()).resolves.toBeNull()
  })

  it('reads back what was written', async () => {
    await writeSkipped('0.2.0')
    await expect(readSkipped()).resolves.toBe('0.2.0')
  })

  it('answers null for a damaged file rather than throwing', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'update.json'), '{ not json', 'utf8')
    await expect(readSkipped()).resolves.toBeNull()
  })

  it('answers null for a well-formed file with the wrong shape', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'update.json'), JSON.stringify({ skipped: 42 }), 'utf8')
    await expect(readSkipped()).resolves.toBeNull()
  })
})

describe('writeSkipped', () => {
  it('creates the config directory when it does not exist yet', async () => {
    await rm(dir, { recursive: true, force: true })
    await writeSkipped('1.0.0')
    await expect(readSkipped()).resolves.toBe('1.0.0')
  })

  it('replaces an earlier skip rather than appending', async () => {
    await writeSkipped('0.2.0')
    await writeSkipped('0.3.0')
    await expect(readSkipped()).resolves.toBe('0.3.0')
  })
})
