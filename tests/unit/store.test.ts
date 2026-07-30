import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// afterEach is used both for temp-dir cleanup and PRCLI_CONFIG_DIR restore.
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, type PrcliConfig } from '../../src/main/state/store'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-store-'))
  file = join(dir, 'config.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sampleConfig: PrcliConfig = {
  version: 1,
  tabs: [
    {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
    },
  ],
}

describe('ConfigStore.read', () => {
  it('returns an empty config when the file does not exist', async () => {
    await expect(new ConfigStore(file).read()).resolves.toEqual({ version: 1, tabs: [] })
  })

  it('returns an empty config when the file is corrupt', async () => {
    await writeFile(file, '{not json', 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({ version: 1, tabs: [] })
  })

  it('returns an empty config when the shape is wrong', async () => {
    await writeFile(file, JSON.stringify({ version: 1, tabs: 'nope' }), 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({ version: 1, tabs: [] })
  })
})

describe('ConfigStore.write', () => {
  it('round-trips a config', async () => {
    const store = new ConfigStore(file)
    await store.write(sampleConfig)
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })

  it('creates the parent directory', async () => {
    const nested = join(dir, 'deep', 'config.json')
    await new ConfigStore(nested).write(sampleConfig)
    await expect(readFile(nested, 'utf8')).resolves.toContain('lumio')
  })

  it('writes atomically, leaving no temp file behind', async () => {
    await new ConfigStore(file).write(sampleConfig)
    await expect(readdir(dir)).resolves.toEqual(['config.json'])
  })

  it('does not corrupt the existing file when given unserialisable input', async () => {
    const store = new ConfigStore(file)
    await store.write(sampleConfig)
    const circular = { version: 1, tabs: [] } as unknown as PrcliConfig
    ;(circular as unknown as { self: unknown }).self = circular
    await expect(store.write(circular)).rejects.toThrow()
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })
})

describe('ConfigStore.defaultPath', () => {
  const original = process.env.PRCLI_CONFIG_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.PRCLI_CONFIG_DIR
    else process.env.PRCLI_CONFIG_DIR = original
  })

  it('points at ~/.prcli/config.json by default', () => {
    delete process.env.PRCLI_CONFIG_DIR
    expect(ConfigStore.defaultPath()).toMatch(/\.prcli\/config\.json$/)
  })

  it('honours PRCLI_CONFIG_DIR so tests never touch the real config', () => {
    process.env.PRCLI_CONFIG_DIR = '/tmp/prcli-override'
    expect(ConfigStore.defaultPath()).toBe('/tmp/prcli-override/config.json')
  })
})
