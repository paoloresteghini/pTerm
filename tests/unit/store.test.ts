/**
 * Mutation record: `isPane`'s per-kind guard, `describe('ConfigStore
 * migration, v7 to v8')`.
 *
 * `still rejects a terminal row with no session` and `still rejects a row
 * with no type and no session` passed at RED before `isPane`/`migrate` were
 * taught v8, and passed for the wrong reason: a `version: 8` file was an
 * unrecognised future version, so `migrate` refused the whole file and
 * `config.panes` came back `[]` regardless of what the individual rows
 * looked like. Neither test exercised `isPane`'s per-kind guard at all until
 * v8 became a recognised version. Recorded here so a reader of just these two
 * tests does not assume they always meant something.
 *
 * Measured (`isPane`'s final line changed to `return true`, migrate already
 * teaching v8): `npx vitest run tests/unit/store.test.ts` -> 2 failed, 57
 * passed. The two that failed were exactly `still rejects a terminal row
 * with no session` and `still rejects a row with no type and no session`,
 * each on `expect(config.panes).toEqual([])`, receiving the malformed rows
 * back instead of an empty array. Restored, and `git diff src/main/state/
 * store.ts` confirmed empty for that line before committing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// afterEach is used both for temp-dir cleanup and PTERM_CONFIG_DIR restore.
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, DEFAULT_NOTIFICATIONS, type PTermConfig } from '../../src/main/state/store'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-store-'))
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

const sampleConfig: PTermConfig = {
  version: 9,
  activeProjectId: 'p1',
  projects: [
    {
      id: 'p1',
      name: 'Lumio',
      slug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      presets: [{ id: 'pr1', label: 'dev', command: 'npm run dev' }],
      activeTabId: 'a1b2c3d4e5f60718',
      activeBrowserTabId: null,
    },
  ],
  panes: [
    {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      tmuxSession: 'pterm-lumio-a1b2c3d4e5f60718',
      type: 'shell',
    },
  ],
  tabs: [
    {
      id: 'a1b2c3d4e5f60718',
      groupId: 'a1b2c3d4e5f60718',
      activePaneId: 'a1b2c3d4e5f60718',
      layout: { dir: 'row', ratio: [1], kids: ['a1b2c3d4e5f60718'] },
    },
  ],
  notifications: DEFAULT_NOTIFICATIONS,
  theme: 'classic',
}

/** Two panes side by side under one tab — the shape v4 could not express. */
const splitConfig: PTermConfig = {
  version: 9,
  activeProjectId: null,
  projects: [],
  panes: [
    {
      id: 'a'.repeat(16),
      projectSlug: 'lumio',
      cwd: '/tmp',
      tmuxSession: `pterm-lumio-${'a'.repeat(16)}`,
      type: 'shell',
    },
    {
      id: 'b'.repeat(16),
      projectSlug: 'lumio',
      cwd: '/tmp',
      tmuxSession: `pterm-lumio-${'b'.repeat(16)}`,
      type: 'claude',
    },
  ],
  tabs: [
    {
      id: 'a'.repeat(16),
      groupId: 'a'.repeat(16),
      activePaneId: 'b'.repeat(16),
      layout: { dir: 'col', ratio: [0.25, 0.75], kids: ['a'.repeat(16), 'b'.repeat(16)] },
    },
  ],
  notifications: DEFAULT_NOTIFICATIONS,
  theme: 'classic',
}

/** What `read()` answers with when it has nothing it can trust. */
const EMPTY_CONFIG: PTermConfig = {
  version: 9,
  activeProjectId: null,
  projects: [],
  panes: [],
  tabs: [],
  notifications: DEFAULT_NOTIFICATIONS,
  theme: 'classic',
}

describe('ConfigStore.read', () => {
  it('returns an empty config when the file does not exist', async () => {
    await expect(new ConfigStore(file).read()).resolves.toEqual(EMPTY_CONFIG)
  })

  it('returns an empty config when the file is corrupt', async () => {
    await writeFile(file, '{not json', 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual(EMPTY_CONFIG)
  })

  it('returns an empty config when the shape is wrong', async () => {
    await writeFile(file, JSON.stringify({ version: 1, tabs: 'nope' }), 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual(EMPTY_CONFIG)
  })
})

describe('ConfigStore.write', () => {
  it('round-trips a config', async () => {
    const store = new ConfigStore(file)
    await store.write(sampleConfig)
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })

  // The whole point of v5: orientation and drag ratios are the two things tmux
  // cannot report, so a split that does not survive the round trip is a split
  // the app cannot restore.
  it('round-trips a two-pane tab with its axis and ratios intact', async () => {
    const store = new ConfigStore(file)
    await store.write(splitConfig)
    await expect(store.read()).resolves.toEqual(splitConfig)
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
  //
  // v5 raises the stakes rather than settling them: a v4 build reads a v5 file
  // as "no config", and the full file it then writes back drops every split.
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
    const circular = { version: 8, panes: [], tabs: [] } as unknown as PTermConfig
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

    await expect(store.read()).resolves.toMatchObject({ panes: [] })
  })

  it('drops tab rows of every wrong shape, keeping the good one', async () => {
    const good = {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/tmp',
      tmuxSession: 'pterm-lumio-a1b2c3d4e5f60718',
      type: 'shell',
    }
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [null, 'a string', 42, [], { id: 'no other fields' }, good],
    })

    await expect(store.read()).resolves.toMatchObject({ panes: [good] })
  })

  /**
   * The one field in this file that grants a capability rather than describing
   * a pane.
   *
   * `agentSessionId` means "an agent may drive this pane right now"
   * (`TabDescriptor` in `shared/ipc.ts`, `agentSessions` in
   * `main/ipc/register.ts`). Nothing in this app writes it to disk, and until
   * this test it survived a read anyway, because `isPane` accepts extra
   * properties and `normalisePane` copies by spread. That is the difference
   * between a field this app happens not to write and a field a file cannot
   * assert.
   *
   * It matters because of who edits this file. The principal the browser tool
   * is scoped against is an agent with a shell, running in a pane, in a
   * project whose config this is: writing `"agentSessionId": "<its own pane
   * id>"` onto the user's hand-opened browser row is one `Edit` away, and
   * `browserPaneFor` (`main/mcp/route.ts`) routes on exactly that field. The
   * pane would then be driven by the tool while `agentSessions` still says
   * nobody owns it, so `refusesNonLoopback` would not confine it either.
   *
   * Stripped here rather than at the one reader that routes on it, so that
   * every reader of a pane row gets the same answer: the runtime map is the
   * record of ownership, and this file cannot vote.
   */
  it('drops an agentSessionId a hand edit put on a pane row', async () => {
    const store = await storeWith({
      version: 9,
      projects: [],
      activeProjectId: null,
      panes: [
        {
          id: 'a'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          type: 'browser',
          url: 'http://localhost:3000/',
          agentSessionId: 'b'.repeat(16),
        },
      ],
      tabs: [],
    })

    const config = await store.read()

    // The row survives, and only the claim is gone: a forged field is not a
    // reason to take the user's browser pane away from them.
    expect(config.panes).toHaveLength(1)
    expect(config.panes[0]).not.toHaveProperty('agentSessionId')
    expect(config.panes[0].url).toBe('http://localhost:3000/')
  })

  it('keeps one pane row per id when the file names the same pane twice', async () => {
    // Not a shape this app writes deliberately, and reachable anyway: nothing
    // between `store.write` and the file dedupes `panes`, and `read()`'s own
    // `paneRows` filters and normalises without ever looking at an id it has
    // already seen. `tabRows` next door has deduped kids across rows since v5,
    // through its shrinking `known` set, which is the rule copied here.
    //
    // The consequence is not cosmetic. `state.panes` is what the tab bar maps
    // over, keyed by pane id, so a duplicate is two React children under one
    // key; `paneGroups` then drops the second by `seen`.
    //
    // It does NOT leave a row with no pane behind it, which is what this
    // comment claimed until 2026-08-05, when it was measured against
    // `tabsOfProject` and `paneGroups` rather than reasoned about: both rows
    // carry the same id, so clicking either selects the same pane and shows the
    // same group. What it leaves is two rows that do the same thing and may say
    // different things, each rendering from its own record while the one box
    // that exists is built from the first. See `paneRows` in `store.ts`.
    const first = {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/tmp',
      tmuxSession: 'pterm-lumio-a1b2c3d4e5f60718',
      type: 'shell',
    }
    const store = await storeWith({
      version: 8,
      projects: [],
      activeProjectId: null,
      tabs: [],
      // The second copy differs, so the assertion below says WHICH one
      // survived rather than only how many did. First wins, like `tabRows`.
      panes: [first, { ...first, cwd: '/somewhere/else' }],
    })

    await expect(store.read()).resolves.toMatchObject({ panes: [first] })
  })

  it('drops a v5 tab row of every wrong shape without throwing', async () => {
    const store = await storeWith({
      ...splitConfig,
      tabs: [null, 'a string', 42, [], { id: 'no layout' }, ...splitConfig.tabs],
    })

    await expect(store.read()).resolves.toMatchObject({ tabs: splitConfig.tabs })
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
        tmuxSession: 'pterm-scratch-a1b2c3d4e5f60718',
      },
      {
        id: '00000000000000ff',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'pterm-scratch-00000000000000ff',
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
        tmuxSession: 'pterm-scratch-a1b2c3d4e5f60718',
      },
    ],
  }

  it('reads a v2 file as v9, keeping tab order', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(9)
    expect(config.panes.map((pane) => pane.id)).toEqual([
      'a1b2c3d4e5f60718',
      '00000000000000ff',
    ])
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
    expect(config.version).toBe(9)
    expect(config.panes.map((pane) => pane.id)).toEqual(['a1b2c3d4e5f60718'])
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
          tmuxSession: 'pterm-lumio-a1b2c3d4e5f60718',
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
    await expect(new ConfigStore(file).read()).resolves.toEqual(EMPTY_CONFIG)
  })

  // The next version up, not a distant one: v10 is the file a build one step
  // ahead of this one leaves behind, and it is the version this build is most
  // likely to actually meet. Reading its `panes` as if the shape had not moved
  // is exactly the guess `write()`'s refusal exists to keep off disk.
  //
  // Moved from v9 to v10 when the theme id landed. v9 is now a version this
  // build understands, so leaving this at 9 would have kept a green test that
  // asserted the opposite of the code.
  it('refuses to guess at a v10 file, one version ahead', async () => {
    await writeFile(file, JSON.stringify({ ...splitConfig, version: 10 }), 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual(EMPTY_CONFIG)
  })

  it('migrates a v3 config to v9, typing tabs by whether they carry a command', async () => {
    const store = await storeWith({
      version: 3,
      projects: [],
      activeProjectId: null,
      tabs: [
        { id: 'a'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'pterm-lumio-' + 'a'.repeat(16) },
        {
          id: 'b'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          command: 'npm run dev',
          tmuxSession: 'pterm-lumio-' + 'b'.repeat(16),
        },
      ],
    })

    const config = await store.read()

    expect(config.version).toBe(9)
    // A v3 tab cannot say whether it was running Claude, and it does not need
    // to: hooks decide. Only the launch command is knowable from the record.
    expect(config.panes[0]?.type).toBe('shell')
    expect(config.panes[1]?.type).toBe('preset')
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
        { id: 'c'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'pterm-lumio-' + 'c'.repeat(16), type: 'shell' },
        { id: 'no-cwd', projectSlug: 'lumio', tmuxSession: 'x' },
      ],
      notifications: { rules: [], muteWhenFocused: true, quietHours: null },
    })

    const config = await store.read()

    expect(config.panes).toHaveLength(1)
    expect(config.panes[0]?.id).toBe('c'.repeat(16))
  })

  it('defaults a v4 tab missing its type rather than dropping the tab', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [
        { id: 'd'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'pterm-lumio-' + 'd'.repeat(16) },
      ],
      notifications: { rules: [], muteWhenFocused: true, quietHours: null },
    })

    const config = await store.read()

    // A live session is worth more than a correct type field.
    expect(config.panes).toHaveLength(1)
    expect(config.panes[0]?.type).toBe('shell')
  })

  it('carries a pane title through a v7 read', async () => {
    const store = await storeWith({
      version: 7,
      projects: [],
      activeProjectId: null,
      panes: [
        {
          id: 'a'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          tmuxSession: 'pterm-lumio-' + 'a'.repeat(16),
          type: 'shell',
          title: 'payments api',
        },
      ],
      tabs: [],
    })
    const config = await store.read()
    expect(config.version).toBe(9)
    expect(config.panes[0].title).toBe('payments api')
  })

  const colouredPane = (color: unknown) => ({
    version: 7,
    projects: [],
    activeProjectId: null,
    panes: [
      {
        id: 'a'.repeat(16),
        projectSlug: 'lumio',
        cwd: '/tmp',
        tmuxSession: 'pterm-lumio-' + 'a'.repeat(16),
        type: 'shell',
        color,
      },
    ],
    tabs: [],
  })

  it('carries an offered pane colour through a v7 read', async () => {
    const store = await storeWith(colouredPane('#232326'))
    const config = await store.read()
    expect(config.panes[0].color).toBe('#232326')
  })

  // The reason `isPaneColor` is called in `normalisePane` and not only at the
  // picker. Config is a text file: nothing stops a hand edit putting white in
  // this field, and the renderer would hand it straight to xterm's theme,
  // leaving `#d4d4d8` text on `#ffffff` in a pane with no way back except
  // another edit of the same file.
  it('drops a pane colour that is not one of the offered ones', async () => {
    const store = await storeWith(colouredPane('#ffffff'))
    const config = await store.read()
    expect(config.panes[0].color).toBeUndefined()
    // The rest of the row survives it: a bad colour is not a bad pane.
    expect(config.panes[0].id).toBe('a'.repeat(16))
    expect(config.panes[0].type).toBe('shell')
  })

  it('drops a pane colour that is not a string', async () => {
    const store = await storeWith(colouredPane(17))
    const config = await store.read()
    expect(config.panes[0].color).toBeUndefined()
  })

  // A title is display text read straight back out to the screen, and config is
  // a file a user can edit. Everything else in this store sanitises what it
  // reads; a title is not the one field to trust.
  it('drops a title that is not a string', async () => {
    const store = await storeWith({
      version: 7,
      projects: [],
      activeProjectId: null,
      panes: [
        {
          id: 'a'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          tmuxSession: 'pterm-lumio-' + 'a'.repeat(16),
          type: 'shell',
          title: { evil: true },
        },
      ],
      tabs: [],
    })
    const config = await store.read()
    expect(config.panes).toHaveLength(1)
    expect(config.panes[0].title).toBeUndefined()
  })

  // v5 is the shape this feature was added to. A row from it was never named,
  // which is exactly what an absent title already means, so the migration has
  // nothing to invent.
  it('migrates a v5 config to v9, leaving panes unnamed and uncoloured', async () => {
    const store = await storeWith({
      version: 5,
      projects: [],
      activeProjectId: null,
      panes: [
        {
          id: 'a'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          tmuxSession: 'pterm-lumio-' + 'a'.repeat(16),
          type: 'shell',
        },
      ],
      tabs: [],
    })
    const config = await store.read()
    expect(config.version).toBe(9)
    expect(config.panes).toHaveLength(1)
    expect(config.panes[0].id).toBe('a'.repeat(16))
    expect(config.panes[0].title).toBeUndefined()
  })
})

describe('ConfigStore migration, v7 to v8', () => {
  it('accepts a sessionless editor row', async () => {
    const store = await storeWith({
      version: 8,
      projects: [],
      activeProjectId: null,
      panes: [
        { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'editor', filePath: '/tmp/demo/a.ts' },
      ],
      tabs: [],
    })

    const config = await store.read()

    expect(config.panes).toHaveLength(1)
    expect(config.panes[0]?.type).toBe('editor')
    expect(config.panes[0]?.filePath).toBe('/tmp/demo/a.ts')
    expect(config.panes[0]?.tmuxSession).toBeUndefined()
  })

  // The half that must NOT relax. A terminal row with no session is the
  // malformed row `isPane` has always rejected, and making `tmuxSession`
  // optional on the type is exactly how that rejection gets lost by accident.
  it('still rejects a terminal row with no session', async () => {
    const store = await storeWith({
      version: 8,
      projects: [],
      activeProjectId: null,
      panes: [
        { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'shell' },
        { id: 'p2', projectSlug: 'demo', cwd: '/tmp/demo', type: 'claude' },
        { id: 'p3', projectSlug: 'demo', cwd: '/tmp/demo', type: 'preset', command: 'x' },
      ],
      tabs: [],
    })

    const config = await store.read()

    expect(config.panes).toEqual([])
  })

  // A row predating `type` is a terminal row: every version before this one
  // only had terminals. So a missing type still requires a session.
  it('still rejects a row with no type and no session', async () => {
    const store = await storeWith({
      version: 8,
      projects: [],
      activeProjectId: null,
      panes: [{ id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo' }],
      tabs: [],
    })

    const config = await store.read()

    expect(config.panes).toEqual([])
  })

  // Same reasoning as the colour field: config is a text file, and a
  // hand-edited `filePath` of the wrong type must not reach the renderer.
  it('drops a filePath that is not a string', async () => {
    const store = await storeWith({
      version: 8,
      projects: [],
      activeProjectId: null,
      panes: [{ id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'editor', filePath: 42 }],
      tabs: [],
    })

    const config = await store.read()

    // The row survives, because an editor pane with no file is a pane that
    // says the file is gone (Task 5), not a row worth discarding.
    expect(config.panes).toHaveLength(1)
    expect(config.panes[0]?.filePath).toBeUndefined()
  })

  it('reads a v7 file as v9 without converting anything', async () => {
    const store = await storeWith({
      version: 7,
      projects: [],
      activeProjectId: null,
      panes: [
        { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'shell', tmuxSession: 'pterm-demo-p1' },
      ],
      tabs: [],
    })

    const config = await store.read()

    expect(config.version).toBe(9)
    expect(config.panes[0]?.tmuxSession).toBe('pterm-demo-p1')
    expect(config.panes[0]?.filePath).toBeUndefined()
  })

  it('keeps a browser row that has no tmux session', async () => {
    const store = await storeWith({
      ...sampleConfig,
      panes: [
        {
          id: 'b1',
          projectSlug: 'demo',
          cwd: '/tmp/demo',
          type: 'browser',
          url: 'http://localhost:3000/',
        },
      ],
    })
    const config = await store.read()
    expect(config.panes).toEqual([
      { id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 'http://localhost:3000/' },
    ])
  })

  it('keeps a browser row but drops a non-string url', async () => {
    const store = await storeWith({
      ...sampleConfig,
      panes: [{ id: 'b2', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 42 }],
    })
    const config = await store.read()
    expect(config.panes[0]?.type).toBe('browser')
    expect(config.panes[0]?.url).toBeUndefined()
  })
})

describe('ConfigStore migration, v4 to v5', () => {
  const claudePane = {
    id: 'a'.repeat(16),
    projectSlug: 'lumio',
    cwd: '/Users/paolo/Code/Lumio',
    tmuxSession: `pterm-lumio-${'a'.repeat(16)}`,
    type: 'claude',
  }
  const devPane = {
    id: 'b'.repeat(16),
    projectSlug: 'lumio',
    cwd: '/Users/paolo/Code/Lumio',
    command: 'npm run dev',
    tmuxSession: `pterm-lumio-${'b'.repeat(16)}`,
    type: 'preset',
  }
  const v4 = {
    version: 4,
    activeProjectId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'Lumio',
        slug: 'lumio',
        cwd: '/Users/paolo/Code/Lumio',
        presets: [],
        activeTabId: 'a'.repeat(16),
      },
    ],
    tabs: [claudePane, devPane],
    notifications: DEFAULT_NOTIFICATIONS,
  }

  it('keeps every v4 tab row as a pane, in order and field for field', async () => {
    const config = await (await storeWith(v4)).read()

    expect(config.version).toBe(9)
    expect(config.panes).toHaveLength(2)
    // Pane by pane rather than by id alone: a migration that dropped `command`
    // or `type` would keep both ids and still cost the user a preset tab.
    expect(config.panes[0]).toEqual(claudePane)
    expect(config.panes[1]).toEqual(devPane)
  })

  it('gives each migrated pane a tab of its own, active and full-width', async () => {
    const config = await (await storeWith(v4)).read()

    // Asserted before the loop, not after it: a migration that produced no tab
    // rows at all would sail through `for (const … of [])` with every
    // assertion below unrun. That shape has already produced ten tests on this
    // project that could not fail.
    expect(config.tabs).toHaveLength(2)
    for (const [index, tab] of config.tabs.entries()) {
      const pane = config.panes[index]
      // A v4 tab genuinely was a one-pane tab, so the founder is the only pane
      // there is, and it is necessarily the active one.
      expect(tab.id).toBe(pane.id)
      expect(tab.activePaneId).toBe(pane.id)
      expect(tab.layout).toEqual({ dir: 'row', ratio: [1], kids: [pane.id] })
    }
  })

  it('keeps projects and the selected one across the migration', async () => {
    const config = await (await storeWith(v4)).read()

    expect(config.projects.map((project) => project.slug)).toEqual(['lumio'])
    expect(config.activeProjectId).toBe('p1')
  })

  it('gives a v1 file the same one-tab-per-pane treatment as a v4 one', async () => {
    // Every version before v5 stored one row per tab because a tab *was* one
    // pane, so they all migrate through the same step rather than each getting
    // its own copy of it.
    const config = await (
      await storeWith({
        version: 1,
        tabs: [
          {
            id: 'e'.repeat(16),
            projectSlug: 'scratch',
            cwd: '/tmp',
            tmuxSession: `pterm-scratch-${'e'.repeat(16)}`,
          },
        ],
      })
    ).read()

    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0]).toEqual({
      id: 'e'.repeat(16),
      // A tab that was one pane is its own founder and its own tmux group, so
      // all three ids are that pane's. Every v5 file written before the two
      // were split reads back the same way — see the row below.
      groupId: 'e'.repeat(16),
      activePaneId: 'e'.repeat(16),
      layout: { dir: 'row', ratio: [1], kids: ['e'.repeat(16)] },
    })
  })
})

describe('ConfigStore.read, v5 layouts', () => {
  const [paneA, paneB] = splitConfig.panes

  /** A v5 file with `splitConfig`'s panes and whatever tab rows are given. */
  function withTabs(tabs: unknown[]): Promise<ConfigStore> {
    return storeWith({ ...splitConfig, tabs })
  }

  it('normalises a malformed layout away instead of throwing through read()', async () => {
    const store = await withTabs([{ id: paneA.id, activePaneId: null, layout: 'nonsense' }])

    // `read()` never throws, and a layout is the one part of config the app can
    // rebuild from nothing: the panes are still there, and restore synthesises
    // a one-pane tab for each pane no saved tab claims.
    const config = await store.read()

    expect(config.tabs).toEqual([])
    expect(config.panes).toHaveLength(2)
  })

  // The whole of why splitting a tab's permanent id from its tmux group id
  // needed no version bump: every v5 row written before the split was named
  // after the group it was in, so `id` IS the group id for all of them, and
  // defaulting the new field to it says exactly that. A row that has since
  // re-founded carries both and is read as it was written.
  it('reads a v5 row with no group id as one whose group is its own', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneA.id,
        layout: { dir: 'row', ratio: [0.5, 0.5], kids: [paneA.id, paneB.id] },
      },
    ])

    const config = await store.read()

    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0].id).toBe(paneA.id)
    expect(config.tabs[0].groupId).toBe(paneA.id)
  })

  it('keeps a group id that differs from the row id, for a tab that re-founded', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        groupId: paneB.id,
        activePaneId: paneA.id,
        layout: { dir: 'row', ratio: [0.5, 0.5], kids: [paneA.id, paneB.id] },
      },
    ])

    const config = await store.read()

    expect(config.tabs).toHaveLength(1)
    // Defaulting this one to `id` too would silently point the tab at a group
    // tmux no longer has, and restore would then read it as a tab it has never
    // seen — losing the layout and, with it, the id the renderer keys on.
    expect(config.tabs[0].id).toBe(paneA.id)
    expect(config.tabs[0].groupId).toBe(paneB.id)
  })

  it('drops a layout kid naming a pane that is not on disk', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneA.id,
        layout: { dir: 'row', ratio: [0.5, 0.5], kids: [paneA.id, 'f'.repeat(16)] },
      },
    ])

    const config = await store.read()

    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0].layout.kids).toEqual([paneA.id])
    // Redistributed, not left at 0.5: a survivor keeping the share it had when
    // it was one of two would render at half width with nothing beside it.
    expect(config.tabs[0].layout.ratio).toEqual([1])
  })

  it('redistributes the ratios of the kids that survive', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneA.id,
        layout: {
          dir: 'col',
          ratio: [0.2, 0.2, 0.6],
          kids: [paneA.id, paneB.id, 'f'.repeat(16)],
        },
      },
    ])

    const config = await store.read()

    const { ratio, kids } = config.tabs[0].layout
    expect(kids).toEqual([paneA.id, paneB.id])
    expect(ratio).toHaveLength(2)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // The two survivors were equal before, so they stay equal after.
    expect(ratio[0]).toBeCloseTo(0.5)
  })

  it('splits evenly when the ratios on disk are not usable', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneA.id,
        layout: { dir: 'row', ratio: [0, 'half'], kids: [paneA.id, paneB.id] },
      },
    ])

    const config = await store.read()

    // A zero share would render a pane the user cannot see and cannot drag
    // back, which is worse than ignoring a hand-edited ratio array entirely.
    expect(config.tabs[0].layout.ratio).toEqual([0.5, 0.5])
  })

  it('drops a tab whose panes have all gone', async () => {
    const store = await withTabs([
      {
        id: 'f'.repeat(16),
        activePaneId: 'f'.repeat(16),
        layout: { dir: 'row', ratio: [1], kids: ['f'.repeat(16)] },
      },
      ...splitConfig.tabs,
    ])

    const config = await store.read()

    // This is also how a forgotten pane's tab row clears itself: `forgetTab`
    // removes the pane row, and the next read collects the layout entry left
    // pointing at it.
    expect(config.tabs.map((tab) => tab.id)).toEqual([splitConfig.tabs[0].id])
  })

  it('forgets an active pane that is no longer part of the tab', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneB.id,
        layout: { dir: 'row', ratio: [1], kids: [paneA.id] },
      },
    ])

    const config = await store.read()

    // Selection has to name something the tab actually holds; null means "the
    // first one", which is a pane that exists.
    expect(config.tabs[0].activePaneId).toBeNull()
  })

  // Not a shape this app writes, and one a hand-edited or half-written file
  // can have. A pane drawn in two tabs at once has no sane rendering, so the
  // first row to name it keeps it — the same first-wins rule `normaliseLayout`
  // already applies to a kid repeated WITHIN one row.
  it('lets only one tab row claim a pane', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneA.id,
        layout: { dir: 'row', ratio: [0.5, 0.5], kids: [paneA.id, paneB.id] },
      },
      {
        id: paneB.id,
        activePaneId: paneB.id,
        layout: { dir: 'row', ratio: [1], kids: [paneB.id] },
      },
    ])

    const config = await store.read()

    // The second row named nothing of its own, so it goes the way a row naming
    // only dead panes goes.
    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0].id).toBe(paneA.id)
    expect(config.tabs[0].layout.kids).toEqual([paneA.id, paneB.id])
  })

  it('leaves a second row holding whatever the first did not claim', async () => {
    const store = await withTabs([
      {
        id: paneA.id,
        activePaneId: paneA.id,
        layout: { dir: 'row', ratio: [1], kids: [paneA.id] },
      },
      {
        id: paneB.id,
        activePaneId: paneB.id,
        // Claims the pane above as well as its own.
        layout: { dir: 'row', ratio: [0.25, 0.75], kids: [paneA.id, paneB.id] },
      },
    ])

    const config = await store.read()

    // Both tabs survive; only the duplicate kid goes.
    expect(config.tabs.map((tab) => tab.id)).toEqual([paneA.id, paneB.id])
    expect(config.tabs[1].layout.kids).toEqual([paneB.id])
    // And the row that lost a kid still describes a whole tab rather than the
    // 0.75 it had when it thought it held two.
    expect(config.tabs[1].layout.ratio).toEqual([1])
  })

  it('defaults an unreadable axis to a row rather than dropping the tab', async () => {
    const store = await withTabs([
      { id: paneA.id, activePaneId: paneA.id, layout: { ratio: [1], kids: [paneA.id] } },
    ])

    const config = await store.read()

    expect(config.tabs[0].layout.dir).toBe('row')
  })
})

describe('ConfigStore.defaultPath', () => {
  const original = process.env.PTERM_CONFIG_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.PTERM_CONFIG_DIR
    else process.env.PTERM_CONFIG_DIR = original
  })

  it('points at ~/.pterm/config.json by default', () => {
    delete process.env.PTERM_CONFIG_DIR
    expect(ConfigStore.defaultPath()).toMatch(/\.pterm\/config\.json$/)
  })

  it('honours PTERM_CONFIG_DIR so tests never touch the real config', () => {
    process.env.PTERM_CONFIG_DIR = '/tmp/pterm-override'
    expect(ConfigStore.defaultPath()).toBe('/tmp/pterm-override/config.json')
  })
})
