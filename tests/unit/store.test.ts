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
  version: 3,
  activeProjectId: 'p1',
  projects: [
    {
      id: 'p1',
      name: 'Lumio',
      slug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      presets: [{ id: 'pr1', label: 'dev', command: 'npm run dev' }],
      activeTabId: 'a1b2c3d4e5f60718',
    },
  ],
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
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 3,
      activeProjectId: null,
      projects: [],
      tabs: [],
    })
  })

  it('returns an empty config when the file is corrupt', async () => {
    await writeFile(file, '{not json', 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 3,
      activeProjectId: null,
      projects: [],
      tabs: [],
    })
  })

  it('returns an empty config when the shape is wrong', async () => {
    await writeFile(file, JSON.stringify({ version: 1, tabs: 'nope' }), 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 3,
      activeProjectId: null,
      projects: [],
      tabs: [],
    })
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
    const circular = { version: 3, tabs: [] } as unknown as PrcliConfig
    ;(circular as unknown as { self: unknown }).self = circular
    await expect(store.write(circular)).rejects.toThrow()
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })
})

describe('ConfigStore migration', () => {
  const v2 = {
    version: 2,
    activeTabId: 'a1b2c3d4e5f60718',
    tabs: [
      {
        id: 'a1b2c3d4e5f60718',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'prcli-scratch-a1b2c3d4e5f60718',
      },
      {
        id: '00000000000000ff',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'prcli-scratch-00000000000000ff',
      },
    ],
  }

  const v1 = {
    version: 1,
    tabs: [
      {
        id: 'a1b2c3d4e5f60718',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'prcli-scratch-a1b2c3d4e5f60718',
      },
    ],
  }

  it('reads a v2 file as v3, keeping tab order', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(3)
    expect(config.tabs.map((tab) => tab.id)).toEqual(['a1b2c3d4e5f60718', '00000000000000ff'])
  })

  // Synthesising a project from the slug is exactly the auto-create-from-slug
  // behaviour this milestone rejects. Migrated tabs belong to no project, and
  // restore surfaces them under Unsorted.
  it('invents no projects from a v2 file', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.projects).toEqual([])
    expect(config.activeProjectId).toBeNull()
  })

  it('drops v2\'s top-level active tab, which is now per-project', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config: unknown = await new ConfigStore(file).read()
    expect(config).not.toHaveProperty('activeTabId')
  })

  it('still reads a v1 file, two versions back', async () => {
    await writeFile(file, JSON.stringify(v1), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(3)
    expect(config.tabs.map((tab) => tab.id)).toEqual(['a1b2c3d4e5f60718'])
    expect(config.projects).toEqual([])
  })

  it('does not rewrite the file on read', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    await new ConfigStore(file).read()
    const onDisk: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect((onDisk as { version: number }).version).toBe(2)
  })

  it('keeps projects and their per-project active tabs on a v3 file', async () => {
    await writeFile(file, JSON.stringify(sampleConfig), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.projects.map((p) => p.slug)).toEqual(['lumio'])
    expect(config.projects[0].activeTabId).toBe('a1b2c3d4e5f60718')
    expect(config.activeProjectId).toBe('p1')
  })

  it('defaults a v3 project with a missing presets array to an empty one', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        activeProjectId: null,
        projects: [{ id: 'p1', name: 'Lumio', slug: 'lumio', cwd: '/tmp', activeTabId: null }],
        tabs: [],
      }),
      'utf8',
    )
    const config = await new ConfigStore(file).read()
    expect(config.projects[0].presets).toEqual([])
  })

  it('drops a project row that is not shaped like one', async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 3, activeProjectId: null, projects: [null, 42], tabs: [] }),
      'utf8',
    )
    await expect(new ConfigStore(file).read().then((c) => c.projects)).resolves.toEqual([])
  })

  it('rejects an unknown future version rather than guessing', async () => {
    await writeFile(file, JSON.stringify({ version: 99, tabs: [] }), 'utf8')
    await expect(new ConfigStore(file).read())
      .resolves.toEqual({ version: 3, activeProjectId: null, projects: [], tabs: [] })
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
