import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager, type PaneRecord } from '../../src/main/sessions/manager'
import {
  ConfigStore,
  type PrcliConfig,
  type ProjectRecord,
  type TabRow,
} from '../../src/main/state/store'
import { restoreWorkspace } from '../../src/main/ipc/restore'
import { UNSORTED_ID, type TabDescriptor } from '../../src/shared/ipc'

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

/**
 * The session of a pane this test expects to be a terminal.
 *
 * `RestoreResult.panes` (what `restoreWorkspace` hands back) holds a mix once
 * an editor pane can survive a relaunch (Task 4), so its declared type cannot
 * promise a session. Every call site below is on a pane this test itself
 * opened or split through `SessionManager` directly, which never produces an
 * editor pane, so the session is always there in practice. Throwing here
 * means a test that somehow gets an editor pane fails saying so, rather than
 * passing `undefined` into tmux and failing somewhere unrecognisable.
 *
 * Applied to every `.tmuxSession` read in this file, including the ones on
 * `SessionManager.open`/`.splitTab`'s own already-narrow return: a read
 * guarded here and an identical one left raw elsewhere is the failure mode
 * this function exists to remove, not a style choice.
 */
function sessionOf(pane: TabDescriptor): string {
  if (pane.tmuxSession === undefined) {
    throw new Error(`pane ${pane.id} has no tmux session; expected a terminal pane`)
  }
  return pane.tmuxSession
}

/** A v5 file, written as the app writes one: flat panes plus tab rows. */
async function v5ConfigWith(config: {
  projects: ProjectRecord[]
  activeProjectId: string | null
  panes: PaneRecord[]
  tabs: TabRow[]
}): Promise<{ store: ConfigStore; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-v5-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ version: 5, ...config }), 'utf8')
  return { store: new ConfigStore(file), file }
}

/**
 * The file exactly as restore wrote it.
 *
 * Read raw rather than through `store.read()` on purpose: `normaliseLayout`
 * rescales a layout's ratios to sum to 1 on the way in, so a reconcile that
 * dropped a pane and never redistributed its share would be repaired by the
 * reader and the test would pass on a defect.
 */
async function written(file: string): Promise<PrcliConfig> {
  return JSON.parse(await readFile(file, 'utf8')) as PrcliConfig
}

/** What tmux itself thinks the session's window measures. */
async function windowSize(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

/** The window a member session is currently showing. */
async function windowIdOf(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_id}',
  ])
  return stdout.trim()
}

/** Whether a tmux session by this name currently exists. */
async function sessionExists(name: string): Promise<boolean> {
  try {
    await run('tmux', ['-L', SOCKET, 'has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

/** Resolves once the tab's client has emitted something matching `match`. */
function waitFor(manager: SessionManager, id: string, match: RegExp, ms = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${match}; saw: ${JSON.stringify(buffer)}`)),
      ms,
    )
    manager.onData((emittedId, data) => {
      if (emittedId !== id) return
      buffer += data
      if (match.test(buffer)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })
}

beforeAll(killServer)
afterEach(killServer)

describe('restoreWorkspace', () => {
  it('adopts a stray session that config has never heard of', async () => {
    await createStray('prcli-lumio-a1b2c3d4e5f60718')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.panes.map((t) => t.id)).toEqual(['a1b2c3d4e5f60718'])
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

    expect(result.panes).toEqual([])
    expect(result.projects[0].activeTabId).toBeNull()
    await expect(store.read().then((c) => c.panes)).resolves.toEqual([])
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

    expect(result.panes.map((t) => t.id)).toEqual([
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
    expect(saved.panes.map((p) => p.id)).toEqual(['1111111111111111'])
    manager.detachAll()
  })

  it('returns an empty workspace when tmux has nothing of ours', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })
    await expect(restoreWorkspace(manager, store, immediate)).resolves.toEqual({
      projects: [],
      panes: [],
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

    expect(result.panes[0]?.type).toBe('claude')
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

/**
 * The half of a relaunch that only a real split can show: live tmux says what
 * exists and how it is grouped, and config supplies the axis and the ratios —
 * the two things tmux cannot report.
 */
describe('restoreWorkspace panes and tabs', () => {
  it('brings a split tab back as one tab, at its saved axis and ratios', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const before = new SessionManager(adapter)
    const founder = before.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 120, rows: 40 })
    await waitFor(before, founder.id, /\$|%|#/)
    const second = await before.splitTab({ paneId: founder.id, cols: 100, rows: 30 })
    before.detachAll()

    const { store, file } = await v5ConfigWith({
      projects: [project('Lumio', 'lumio', tmpdir(), founder.id)],
      activeProjectId: 'id-lumio',
      panes: [founder, second],
      tabs: [
        {
          id: founder.id,
          groupId: founder.id,
          activePaneId: second.id,
          layout: { dir: 'col', ratio: [0.25, 0.75], kids: [founder.id, second.id] },
        },
      ],
    })

    const manager = new SessionManager(adapter)
    const result = await restoreWorkspace(manager, store, immediate)

    // Both panes, and one tab holding both of them.
    expect(result.panes).toHaveLength(2)
    expect(result.panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
    const saved = await written(file)
    expect(saved.panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
    expect(saved.tabs).toHaveLength(1)
    const row = saved.tabs[0]
    expect(row.id).toBe(founder.id)
    expect(row.activePaneId).toBe(second.id)
    expect(row.layout.dir).toBe('col')
    expect(row.layout.kids).toEqual([founder.id, second.id])
    expect(row.layout.ratio).toHaveLength(2)
    expect(row.layout.ratio[0]).toBeCloseTo(0.25)
    expect(row.layout.ratio[1]).toBeCloseTo(0.75)

    // The reconcile hands the tab rows themselves back too, not only the
    // panes — I5: `restoreWorkspace` already built these for the write above
    // and used to drop them on the reply, leaving nothing downstream able to
    // lay out a split without a second read of config. Same ids and kids as
    // what just landed on disk; the ratio check sums the row's own shares
    // rather than only counting them, since two panes at 0.9/0.9 would pass
    // a length check while describing a tab wider than the window it is in.
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs.map((tabRow) => tabRow.id)).toEqual(saved.tabs.map((tabRow) => tabRow.id))
    expect(result.tabs[0].layout.kids).toEqual(row.layout.kids)
    expect(result.tabs[0].layout.dir).toBe(row.layout.dir)
    expect(result.tabs[0].layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

    // Each pane's own window keeps the geometry it had before the relaunch —
    // 120x40 and 100x30. Restore knows no size for a pane (nothing persists
    // one), so it attaches at the manager's default; a default-sized attach
    // must not drive a window it knows nothing about down to 80x24, which is
    // the geometry defect this project has already shipped twice. The spec's
    // Done-when is explicit: "no pane wrapped at 80 columns".
    //
    // Settled first, then asserted plainly — NOT polled. This asserts the
    // ABSENCE of a change, and `expect.poll` returns on its first match, so it
    // would read the window before the attach-time resize it is guarding
    // against could have landed and pass on a value that was about to be
    // wrong. Measured: with the `sized` gate removed the polled form passed in
    // 283ms; with this settle it fails with `expected '80x24' to be '120x40'`.
    // `sizeWindowOnAttach` is a void-ed async call that resolves ~25ms after
    // the attach, so 1.5s is nearly two orders of magnitude of headroom. Same
    // idiom, and the same reason, as `does not resize the sibling's window
    // when it reattaches` in `manager.test.ts`.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await windowSize(sessionOf(founder))).toBe('120x40')
    expect(await windowSize(sessionOf(second))).toBe('100x30')

    // No two live members of this tab may report the same window: one window
    // rendered by two xterms is the failure a fallen-back member causes.
    expect(result.panes.length).toBeGreaterThan(1)
    const windows = await Promise.all(result.panes.map((pane) => windowIdOf(sessionOf(pane))))
    expect(new Set(windows).size).toBe(windows.length)
    manager.detachAll()
  })

  // Two things at once, and deliberately: a ⌘R or a renderer crash restores a
  // second time in one app lifetime, and `findOrphans` excludes sessions this
  // app has attached — so without the `detachAll()` that opens the reconcile,
  // the second pass would see nothing, return an empty workspace and write it
  // over config, stranding every session the user had open. The layout
  // assertions ride along on the pass that reads restore's OWN output rather
  // than a hand-written fixture.
  it('brings the same split tab back on a second restore in one app lifetime', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const before = new SessionManager(adapter)
    const founder = before.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(before, founder.id, /\$|%|#/)
    const second = await before.splitTab({ paneId: founder.id })
    before.detachAll()

    const { store, file } = await v5ConfigWith({
      projects: [project('Lumio', 'lumio', tmpdir(), founder.id)],
      activeProjectId: 'id-lumio',
      panes: [founder, second],
      tabs: [
        {
          id: founder.id,
          groupId: founder.id,
          activePaneId: second.id,
          layout: { dir: 'col', ratio: [0.4, 0.6], kids: [founder.id, second.id] },
        },
      ],
    })

    const manager = new SessionManager(adapter)
    expect((await restoreWorkspace(manager, store, immediate)).panes).toHaveLength(2)
    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
    const saved = await written(file)
    expect(saved.tabs).toHaveLength(1)
    expect(saved.tabs[0].layout.kids).toEqual([founder.id, second.id])
    expect(saved.tabs[0].layout.dir).toBe('col')
    expect(saved.tabs[0].layout.ratio).toHaveLength(2)
    expect(saved.tabs[0].layout.ratio[0]).toBeCloseTo(0.4)
    expect(saved.tabs[0].activePaneId).toBe(second.id)
    manager.detachAll()
  })

  it('drops a saved pane whose session is gone and redistributes its share', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const before = new SessionManager(adapter)
    const founder = before.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(before, founder.id, /\$|%|#/)
    const middle = await before.splitTab({ paneId: founder.id })
    const last = await before.splitTab({ paneId: founder.id })
    // Session and window both, which is what a pane closed from the UI leaves.
    await before.kill(middle.id)
    before.detachAll()
    expect(await sessionExists(sessionOf(middle))).toBe(false)

    const { store, file } = await v5ConfigWith({
      projects: [project('Lumio', 'lumio', tmpdir(), founder.id)],
      activeProjectId: 'id-lumio',
      // All three rows are still on disk, so it is the reconcile — not
      // `store.read()`'s own pruning of a kid with no pane row — that has to
      // notice the middle pane's session has gone.
      panes: [founder, middle, last],
      tabs: [
        {
          id: founder.id,
          groupId: founder.id,
          activePaneId: middle.id,
          layout: { dir: 'row', ratio: [0.2, 0.3, 0.5], kids: [founder.id, middle.id, last.id] },
        },
      ],
    })

    const manager = new SessionManager(adapter)
    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.panes.map((pane) => pane.id).sort()).toEqual([founder.id, last.id].sort())
    const saved = await written(file)
    expect(saved.tabs).toHaveLength(1)
    const layout = saved.tabs[0].layout
    expect(layout.kids).toEqual([founder.id, last.id])
    expect(layout.ratio).toHaveLength(2)
    // The survivors' shares are 0.2 and 0.5 on disk. Redistributed they must
    // still describe a whole tab, and the wider pane must still be the wider
    // one — a share that is merely renormalised keeps both, one that is
    // replaced by an even split keeps only the first.
    expect(layout.ratio[0] + layout.ratio[1]).toBeCloseTo(1)
    expect(layout.ratio[1]).toBeGreaterThan(layout.ratio[0])
    // Selection followed the pane that went.
    expect(saved.tabs[0].activePaneId).toBe(founder.id)
    manager.detachAll()
  })

  // A live tab alongside the dead one, so "dropped" cannot be satisfied by
  // writing nothing at all: an implementation that kept every saved row would
  // write two, and one that wrote none would lose the survivor.
  it('drops a tab whose panes have all gone, and keeps the one that has not', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const gone = [tab('00000000000000ff'), tab('00000000000000fe')]
    const { store, file } = await v5ConfigWith({
      projects: [project('Lumio', 'lumio', tmpdir(), gone[0].id)],
      activeProjectId: 'id-lumio',
      panes: [
        ...gone.map((row) => ({ ...row, type: 'shell' as const })),
        { ...tab('1111111111111111'), type: 'shell' as const },
      ],
      tabs: [
        {
          id: gone[0].id,
          groupId: gone[0].id,
          activePaneId: gone[0].id,
          layout: { dir: 'row', ratio: [0.5, 0.5], kids: [gone[0].id, gone[1].id] },
        },
        {
          id: '1111111111111111',
          groupId: '1111111111111111',
          activePaneId: '1111111111111111',
          layout: { dir: 'row', ratio: [1], kids: ['1111111111111111'] },
        },
      ],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.panes.map((pane) => pane.id)).toEqual(['1111111111111111'])
    const saved = await written(file)
    expect(saved.panes.map((pane) => pane.id)).toEqual(['1111111111111111'])
    expect(saved.tabs.map((row) => row.id)).toEqual(['1111111111111111'])
    manager.detachAll()
  })

  it('gives a pane config never knew about a one-pane tab of its own', async () => {
    await createStray('prcli-lumio-a1b2c3d4e5f60718')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const { store, file } = await v5ConfigWith({
      projects: [],
      activeProjectId: null,
      panes: [],
      tabs: [],
    })

    await restoreWorkspace(manager, store, immediate)

    const saved = await written(file)
    expect(saved.tabs).toHaveLength(1)
    expect(saved.tabs[0]).toEqual({
      id: 'a1b2c3d4e5f60718',
      // Its own group, because an ungrouped session IS a tab of one: nothing
      // saved says otherwise, and this is the only id there is to write.
      groupId: 'a1b2c3d4e5f60718',
      activePaneId: 'a1b2c3d4e5f60718',
      layout: { dir: 'row', ratio: [1], kids: ['a1b2c3d4e5f60718'] },
    })
    manager.detachAll()
  })

  // The one form of a lost window/member binding restore can actually see.
  // Rebinding is not available to it — the only window it could bind a member
  // to is the one that member already reports, which here is the sibling's —
  // so the pane whose window died is pruned instead.
  it('restores one pane, not two, when a dead window left two members sharing one', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const before = new SessionManager(adapter)
    const founder = before.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(before, founder.id, /\$|%|#/)
    const second = await before.splitTab({ paneId: founder.id })
    before.detachAll()
    // The window only. Its member session survives and silently falls back to
    // the founder's window — measured on tmux 3.7b, in both directions.
    const orphanedWindow = await windowIdOf(sessionOf(second))
    await run('tmux', ['-L', SOCKET, 'kill-window', '-t', orphanedWindow])
    expect(await sessionExists(sessionOf(second))).toBe(true)
    const founderWindow = await windowIdOf(sessionOf(founder))
    expect(founderWindow).toMatch(/^@\d+$/)
    expect(await windowIdOf(sessionOf(second))).toBe(founderWindow)

    const { store, file } = await v5ConfigWith({
      projects: [project('Lumio', 'lumio', tmpdir(), founder.id)],
      activeProjectId: 'id-lumio',
      panes: [founder, second],
      tabs: [
        {
          id: founder.id,
          groupId: founder.id,
          activePaneId: founder.id,
          layout: { dir: 'row', ratio: [0.5, 0.5], kids: [founder.id, second.id] },
        },
      ],
    })

    const manager = new SessionManager(adapter)
    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.panes).toHaveLength(1)
    expect(result.panes[0].id).toBe(founder.id)
    // The surviving pane is still looking at the window it always was: the
    // prune must cost the tab a duplicate, not the founder's own process.
    //
    // The duplicate-window invariant this used to assert here is not asserted
    // here any more. With one pane left `new Set(windows).size ===
    // windows.length` is true by construction, and a regression that let the
    // second pane back in would be caught by the `toHaveLength(1)` above
    // before it could reach it — the count was doing all of the work and the
    // invariant none. It is asserted where it can fail, in the two-pane test
    // at the top of this describe.
    expect(await windowIdOf(sessionOf(founder))).toBe(founderWindow)

    // The pruned member is not merely dropped from the tab — it is killed.
    // Dropping alone leaves a live prcli session with no config row and no
    // tab-bar entry, which every future restore prunes again and nothing can
    // ever reach: the spec's "a crashed or closed pane leaves no window and
    // no member session behind", failed permanently. Killing its SESSION is
    // safe precisely because it has no window of its own; its window is the
    // founder's, asserted intact above.
    await expect.poll(() => sessionExists(sessionOf(second)), { timeout: 10_000 }).toBe(false)
    expect(await sessionExists(sessionOf(founder))).toBe(true)

    const saved = await written(file)
    expect(saved.tabs).toHaveLength(1)
    expect(saved.tabs[0].layout.kids).toEqual([founder.id])
    expect(saved.tabs[0].layout.ratio).toEqual([1])
    manager.detachAll()
  })
})
