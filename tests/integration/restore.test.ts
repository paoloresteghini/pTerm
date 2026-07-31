import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'
import { ConfigStore, type ProjectRecord } from '../../src/main/state/store'
import { restoreWorkspace } from '../../src/main/ipc/restore'
import { UNSORTED_ID } from '../../src/shared/ipc'

const run = promisify(execFile)
const SOCKET = 'prcli-test'

/** The config write queue. Restore is the only caller under test, so running
 *  each operation immediately is equivalent to the real serialised queue. */
const immediate = <T>(operation: () => Promise<T>): Promise<T> => operation()

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

/** A prcli-shaped session created behind the app's back, as a crash would leave. */
async function createStray(name: string): Promise<void> {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', name, 'sleep', '600'])
}

/** A tab row exactly as a real v3 file has it — no `type`, which migration infers. */
interface V3Tab {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
}

async function configWith(config: {
  projects: ProjectRecord[]
  activeProjectId: string | null
  tabs: V3Tab[]
}): Promise<ConfigStore> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ version: 3, ...config }), 'utf8')
  return new ConfigStore(file)
}

function project(name: string, slug: string, cwd: string, activeTabId: string | null = null) {
  return { id: `id-${slug}`, name, slug, cwd, presets: [], activeTabId }
}

function tab(id: string, slug = 'lumio') {
  return {
    id,
    projectSlug: slug,
    cwd: tmpdir(),
    tmuxSession: `prcli-${slug}-${id}`,
  }
}

beforeAll(killServer)
afterEach(killServer)

describe('restoreWorkspace', () => {
  it('adopts a stray session that config has never heard of', async () => {
    await createStray('prcli-lumio-a1b2c3d4e5f60718')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.tabs.map((t) => t.id)).toEqual(['a1b2c3d4e5f60718'])
    manager.detachAll()
  })

  it('drops a config row whose session no longer exists', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    // The project's only tab is the dead one, so once it is dropped there is
    // nothing left for its saved active tab to resolve to — the v3 stand-in for
    // the global active tab this test used to null out. Asserting that against
    // an empty project list, as the port first did, asserted nothing: with no
    // projects it is null on every code path.
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '00000000000000ff')],
      activeProjectId: 'id-lumio',
      tabs: [tab('00000000000000ff')],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.tabs).toEqual([])
    expect(result.projects[0].activeTabId).toBeNull()
    await expect(store.read().then((c) => c.tabs)).resolves.toEqual([])
  })

  it('keeps config order and puts unknown strays after it', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    await createStray('prcli-lumio-3333333333333333')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    // Config knows 3 then 1, in that order, and not 2 at all.
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '1111111111111111')],
      activeProjectId: 'id-lumio',
      tabs: [tab('3333333333333333'), tab('1111111111111111')],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.tabs.map((t) => t.id)).toEqual([
      '3333333333333333',
      '1111111111111111',
      '2222222222222222',
    ])
    manager.detachAll()
  })

  it('preserves the saved active tab when its session survived', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    // v3: the active tab is claimed by a project rather than held globally.
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '2222222222222222')],
      activeProjectId: 'id-lumio',
      tabs: [tab('1111111111111111'), tab('2222222222222222')],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].activeTabId),
    ).resolves.toBe('2222222222222222')
    manager.detachAll()
  })

  it('falls back to the first tab when the saved active tab died', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '2222222222222222')],
      activeProjectId: 'id-lumio',
      tabs: [tab('1111111111111111'), tab('2222222222222222')],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].activeTabId),
    ).resolves.toBe('1111111111111111')
    manager.detachAll()
  })

  it('writes the reconciled workspace back to config', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })

    await restoreWorkspace(manager, store, immediate)

    const saved = await store.read()
    expect(saved.tabs.map((t) => t.id)).toEqual(['1111111111111111'])
    manager.detachAll()
  })

  it('returns an empty workspace when tmux has nothing of ours', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })
    await expect(restoreWorkspace(manager, store, immediate)).resolves.toEqual({
      projects: [],
      tabs: [],
      activeProjectId: null,
    })
  })

  // M6: every fixture above is a v3 row with no `type` at all, so the one
  // line here that matters most — `{ ...orphan, cwd: row.cwd, command:
  // row.command, type: row.type }` in restoreWorkspace — is only ever
  // exercised against a type migration *inferred*, never against a real v4
  // row that already says `claude`. Its absence would silently downgrade
  // every claude/preset tab back to plain shell on every relaunch, and
  // nothing above would notice.
  it('carries a v4 row\'s own type through the reconcile, not the shell default the orphan synthesises', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-v4-'))
    const file = join(dir, 'config.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 4,
        projects: [project('Lumio', 'lumio', tmpdir())],
        activeProjectId: 'id-lumio',
        tabs: [
          {
            id: '1111111111111111',
            projectSlug: 'lumio',
            cwd: tmpdir(),
            tmuxSession: 'prcli-lumio-1111111111111111',
            type: 'claude',
          },
        ],
        notifications: { rules: [], muteWhenFocused: true, quietHours: null },
      }),
      'utf8',
    )
    const store = new ConfigStore(file)

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.tabs[0]?.type).toBe('claude')
    manager.detachAll()
  })
})

describe('restoreWorkspace projects', () => {
  it('groups a tab under the project whose slug it carries', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects.map((p) => p.id)).toEqual(['id-lumio'])
    expect(result.projects[0].activeTabId).toBe('1111111111111111')
    manager.detachAll()
  })

  it('puts a tab matching no project under Unsorted, last', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-scratch-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects.map((p) => p.id)).toEqual(['id-lumio', UNSORTED_ID])
    expect(result.projects[1].activeTabId).toBe('2222222222222222')
    manager.detachAll()
  })

  it('omits Unsorted entirely when every tab matches', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects.map((p) => p.id)).not.toContain(UNSORTED_ID)
    manager.detachAll()
  })

  it("resolves each project's active tab independently", async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    await createStray('prcli-gco-3333333333333333')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [
        project('Lumio', 'lumio', tmpdir(), '2222222222222222'),
        project('GCO', 'gco', tmpdir(), '3333333333333333'),
      ],
      activeProjectId: 'id-gco',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects[0].activeTabId).toBe('2222222222222222')
    expect(result.projects[1].activeTabId).toBe('3333333333333333')
    expect(result.activeProjectId).toBe('id-gco')
    manager.detachAll()
  })

  it("falls back to a project's first tab when its saved active tab died", async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '9999999999999999')],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].activeTabId),
    ).resolves.toBe('1111111111111111')
    manager.detachAll()
  })

  it('leaves a project with no live tabs holding no active tab', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '9999999999999999')],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].activeTabId),
    ).resolves.toBeNull()
  })

  it('falls back to the first project when the saved one is gone', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-vanished',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.activeProjectId),
    ).resolves.toBe('id-lumio')
  })

  it('can hold Unsorted as the selected project across a relaunch', async () => {
    await createStray('prcli-scratch-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: UNSORTED_ID, tabs: [] })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.activeProjectId),
    ).resolves.toBe(UNSORTED_ID)
    manager.detachAll()
  })

  it("merges the repo's own presets under the user's", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'prcli-repo-'))
    await writeFile(
      join(cwd, '.prcli.json'),
      JSON.stringify({ presets: [{ label: 'queue', command: 'php artisan queue:work' }] }),
      'utf8',
    )
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [
        {
          ...project('Lumio', 'lumio', cwd),
          presets: [{ id: 'u1', label: 'dev', command: 'npm run dev' }],
        },
      ],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects[0].presets.map((p) => `${p.label}:${p.origin}`)).toEqual([
      'dev:user',
      'queue:repo',
    ])
  })

  it('marks a project whose directory has gone as unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'prcli-gone-'))
    await rm(cwd, { recursive: true, force: true })
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', cwd)],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].available),
    ).resolves.toBe(false)
  })

  it('does not persist the synthetic Unsorted row', async () => {
    await createStray('prcli-scratch-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })

    await restoreWorkspace(manager, store, immediate)

    await expect(store.read().then((c) => c.projects)).resolves.toEqual([])
    manager.detachAll()
  })

  it("writes each project's resolved active tab back to config", async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await restoreWorkspace(manager, store, immediate)

    await expect(store.read().then((c) => c.projects[0].activeTabId)).resolves.toBe(
      '1111111111111111',
    )
    manager.detachAll()
  })

  // A project whose saved active tab died and which has no live tab at all
  // resolves to null, and that null has to reach disk. Coalescing the lookup
  // would read it as "no descriptor found" and leave the dead id on the row,
  // so config would keep pointing at a session that no longer exists.
  it('clears a project\'s active tab when nothing of it is left alive', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '00000000000000ff')],
      activeProjectId: 'id-lumio',
      tabs: [tab('00000000000000ff')],
    })

    await restoreWorkspace(manager, store, immediate)

    await expect(store.read().then((c) => c.projects[0].activeTabId)).resolves.toBeNull()
  })

  // Two projects with different answers, so a row written against the wrong
  // project is visible. One project cannot show that: every mapping, right or
  // wrong, produces the same file.
  it('writes each resolved active tab against its own project row', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-gco-3333333333333333')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [
        project('Lumio', 'lumio', tmpdir()),
        project('GCO', 'gco', tmpdir()),
      ],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await restoreWorkspace(manager, store, immediate)

    await expect(
      store.read().then((c) => c.projects.map((p) => [p.id, p.activeTabId])),
    ).resolves.toEqual([
      ['id-lumio', '1111111111111111'],
      ['id-gco', '3333333333333333'],
    ])
    manager.detachAll()
  })
})
