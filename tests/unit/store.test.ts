import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// afterEach is used both for temp-dir cleanup and PRCLI_CONFIG_DIR restore.
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, DEFAULT_NOTIFICATIONS, type PrcliConfig } from '../../src/main/state/store'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-store-'))
  file = join(dir, 'config.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write an arbitrary raw shape to a fresh config file and open a store on it. */
async function storeWith(raw: unknown): Promise<ConfigStore> {
  await writeFile(file, JSON.stringify(raw), 'utf8')
  return new ConfigStore(file)
}

const sampleConfig: PrcliConfig = {
  version: 4,
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
      type: 'shell',
    },
  ],
  notifications: DEFAULT_NOTIFICATIONS,
}

describe('ConfigStore.read', () => {
  it('returns an empty config when the file does not exist', async () => {
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 4,
      activeProjectId: null,
      projects: [],
      tabs: [],
      notifications: DEFAULT_NOTIFICATIONS,
    })
  })

  it('returns an empty config when the file is corrupt', async () => {
    await writeFile(file, '{not json', 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 4,
      activeProjectId: null,
      projects: [],
      tabs: [],
      notifications: DEFAULT_NOTIFICATIONS,
    })
  })

  it('returns an empty config when the shape is wrong', async () => {
    await writeFile(file, JSON.stringify({ version: 1, tabs: 'nope' }), 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 4,
      activeProjectId: null,
      projects: [],
      tabs: [],
      notifications: DEFAULT_NOTIFICATIONS,
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

  // The carry-forward that stopped being theoretical the moment a v4 config
  // existed. `read()` returns empty for a version it does not understand, and
  // restore then writes a full file over it — so running an older build once,
  // with a newer one's config on disk, destroys every project and rule in it.
  // Two builds have in fact been sharing that file all day.
  it('refuses to overwrite a config written by a newer version', async () => {
    const future = { version: 99, projects: [], tabs: [], somethingNew: true }
    await writeFile(file, JSON.stringify(future), 'utf8')
    const store = new ConfigStore(file)

    await store.write(sampleConfig)

    await expect(readFile(file, 'utf8').then(JSON.parse)).resolves.toEqual(future)
  })

  it('does not throw when it refuses, so an old build still runs', async () => {
    await writeFile(file, JSON.stringify({ version: 99, tabs: [] }), 'utf8')

    // Losing layout is the cost of running the old build; a rejected promise
    // here would surface as a failed IPC call on every ordinary edit.
    await expect(new ConfigStore(file).write(sampleConfig)).resolves.toBeUndefined()
  })

  it('still upgrades a config written by an older version', async () => {
    await writeFile(file, JSON.stringify({ version: 3, tabs: [], projects: [] }), 'utf8')
    const store = new ConfigStore(file)

    await store.write(sampleConfig)

    await expect(store.read()).resolves.toEqual(sampleConfig)
  })

  it('writes over a file too damaged to state a version', async () => {
    // Or a single corrupt byte would lock the config against every future
    // write, which is a worse failure than the one this guard prevents.
    await writeFile(file, 'not json at all', 'utf8')
    const store = new ConfigStore(file)

    await store.write(sampleConfig)

    await expect(store.read()).resolves.toEqual(sampleConfig)
  })

  it('does not corrupt the existing file when given unserialisable input', async () => {
    const store = new ConfigStore(file)
    await store.write(sampleConfig)
    const circular = { version: 4, tabs: [] } as unknown as PrcliConfig
    ;(circular as unknown as { self: unknown }).self = circular
    await expect(store.write(circular)).rejects.toThrow()
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })
})

describe('ConfigStore.read, hostile shapes', () => {
  // Carried forward since v3 as "migrate() does not validate the elements of
  // tabs, so `tabs: [null]` defeats read()'s never-throws contract". It does
  // validate them — `isTab` rejects null before touching a property — and this
  // is the test that says so, rather than the item being closed on a reading.
  it('drops a null tab row instead of throwing through read()', async () => {
    const store = await storeWith({ version: 4, projects: [], tabs: [null], activeProjectId: null })

    await expect(store.read()).resolves.toMatchObject({ tabs: [] })
  })

  it('drops tab rows of every wrong shape, keeping the good one', async () => {
    const good = {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/tmp',
      tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
      type: 'shell',
    }
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [null, 'a string', 42, [], { id: 'no other fields' }, good],
    })

    await expect(store.read()).resolves.toMatchObject({ tabs: [good] })
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

  it('reads a v2 file as v4, keeping tab order', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(4)
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

  it('still reads a v1 file, three versions back', async () => {
    await writeFile(file, JSON.stringify(v1), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(4)
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
    // A genuine v3 file: no tab `type`, no `notifications` block — both are
    // v4 additions sampleConfig now carries, so this is its own fixture
    // rather than a reuse of it.
    const v3Sample = {
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
    await writeFile(file, JSON.stringify(v3Sample), 'utf8')
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
    await expect(new ConfigStore(file).read()).resolves.toEqual({
      version: 4,
      activeProjectId: null,
      projects: [],
      tabs: [],
      notifications: DEFAULT_NOTIFICATIONS,
    })
  })

  it('migrates a v3 config to v4, typing tabs by whether they carry a command', async () => {
    const store = await storeWith({
      version: 3,
      projects: [],
      activeProjectId: null,
      tabs: [
        { id: 'a'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'prcli-lumio-' + 'a'.repeat(16) },
        {
          id: 'b'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          command: 'npm run dev',
          tmuxSession: 'prcli-lumio-' + 'b'.repeat(16),
        },
      ],
    })

    const config = await store.read()

    expect(config.version).toBe(4)
    // A v3 tab cannot say whether it was running Claude, and it does not need
    // to: hooks decide. Only the launch command is knowable from the record.
    expect(config.tabs[0]?.type).toBe('shell')
    expect(config.tabs[1]?.type).toBe('preset')
  })

  it('gives a migrated config the default notification rules', async () => {
    const store = await storeWith({ version: 3, projects: [], activeProjectId: null, tabs: [] })

    const config = await store.read()

    expect(config.notifications.muteWhenFocused).toBe(true)
    expect(config.notifications.quietHours).toBeNull()
    // Sound is off by design: this machine's ~/.claude/settings.json already
    // plays Funk on Notification and Glass on Stop, so shipping the parent
    // spec's default sounds would double-fire them.
    expect(config.notifications.rules.every((rule) => rule.sound === null)).toBe(true)
    expect(config.notifications.rules.some((rule) => rule.on === 'waiting')).toBe(true)
  })

  it('substitutes defaults for a v4 notifications block that is not an object', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [],
      notifications: 'nonsense',
    })

    const config = await store.read()

    // Losing every open tab because a rules array was hand-edited badly is not
    // a trade read()'s never-throws contract permits.
    expect(config.notifications.muteWhenFocused).toBe(true)
    expect(Array.isArray(config.notifications.rules)).toBe(true)
  })

  it('keeps a v4 notifications block the user has edited', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [],
      notifications: {
        rules: [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }],
        muteWhenFocused: false,
        quietHours: { from: '22:00', to: '07:00' },
      },
    })

    const config = await store.read()

    expect(config.notifications.rules).toEqual([
      { on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' },
    ])
    expect(config.notifications.muteWhenFocused).toBe(false)
    expect(config.notifications.quietHours).toEqual({ from: '22:00', to: '07:00' })
  })

  // The carried-forward hole. `read()` promises never to throw, and it did not
  // — it handed restore.ts a null it then dereferenced, which is the same
  // failure one frame later.
  it('drops a tab element that is not a tab, rather than handing it on', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [
        null,
        { id: 'c'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'prcli-lumio-' + 'c'.repeat(16), type: 'shell' },
        { id: 'no-cwd', projectSlug: 'lumio', tmuxSession: 'x' },
      ],
      notifications: { rules: [], muteWhenFocused: true, quietHours: null },
    })

    const config = await store.read()

    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0]?.id).toBe('c'.repeat(16))
  })

  it('defaults a v4 tab missing its type rather than dropping the tab', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [
        { id: 'd'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'prcli-lumio-' + 'd'.repeat(16) },
      ],
      notifications: { rules: [], muteWhenFocused: true, quietHours: null },
    })

    const config = await store.read()

    // A live session is worth more than a correct type field.
    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0]?.type).toBe('shell')
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
