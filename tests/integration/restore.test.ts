import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'
import { ConfigStore, type PrcliConfig } from '../../src/main/state/store'
import { restoreWorkspace } from '../../src/main/ipc/restore'

const run = promisify(execFile)
const SOCKET = 'prcli-test'

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

async function configWith(tabs: PrcliConfig['tabs'], activeTabId: string | null): Promise<ConfigStore> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ version: 2, activeTabId, tabs }), 'utf8')
  return new ConfigStore(file)
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
    const store = await configWith([], null)

    const result = await restoreWorkspace(manager, store)

    expect(result.tabs.map((t) => t.id)).toEqual(['a1b2c3d4e5f60718'])
    manager.detachAll()
  })

  it('drops a config row whose session no longer exists', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([tab('00000000000000ff')], '00000000000000ff')

    const result = await restoreWorkspace(manager, store)

    expect(result.tabs).toEqual([])
    expect(result.activeTabId).toBeNull()
    await expect(store.read().then((c) => c.tabs)).resolves.toEqual([])
  })

  it('keeps config order and puts unknown strays after it', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    await createStray('prcli-lumio-3333333333333333')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    // Config knows 3 then 1, in that order, and not 2 at all.
    const store = await configWith(
      [tab('3333333333333333'), tab('1111111111111111')],
      '1111111111111111',
    )

    const result = await restoreWorkspace(manager, store)

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
    // configWith writes the (now-migrated-away) v2 shape, so this one test
    // writes its own v3 fixture instead of using it.
    const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-'))
    const file = join(dir, 'config.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        activeProjectId: 'id-lumio',
        projects: [
          {
            id: 'id-lumio',
            name: 'Lumio',
            slug: 'lumio',
            cwd: tmpdir(),
            presets: [],
            activeTabId: '2222222222222222',
          },
        ],
        tabs: [tab('1111111111111111'), tab('2222222222222222')],
      }),
      'utf8',
    )
    const store = new ConfigStore(file)

    await expect(restoreWorkspace(manager, store).then((r) => r.activeTabId))
      .resolves.toBe('2222222222222222')
    manager.detachAll()
  })

  it('falls back to the first tab when the saved active tab died', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith(
      [tab('1111111111111111'), tab('2222222222222222')],
      '2222222222222222',
    )

    await expect(restoreWorkspace(manager, store).then((r) => r.activeTabId))
      .resolves.toBe('1111111111111111')
    manager.detachAll()
  })

  it('writes the reconciled workspace back to config', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([], null)

    await restoreWorkspace(manager, store)

    const saved = await store.read()
    expect(saved.tabs.map((t) => t.id)).toEqual(['1111111111111111'])
    manager.detachAll()
  })

  it('returns an empty workspace when tmux has nothing of ours', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([], null)
    await expect(restoreWorkspace(manager, store)).resolves.toEqual({ tabs: [], activeTabId: null })
  })
})
