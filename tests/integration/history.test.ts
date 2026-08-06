import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryEntry } from '../../src/shared/ipc'

// registerIpc reaches for electron's ipcMain, which does not exist outside
// the main process. Capturing the handlers here is the same pattern
// persistence.test.ts uses to drive channels without a real Electron host.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => ipc.handlers.set(channel, fn),
    on: () => undefined,
  },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
}))

const { CHANNELS } = await import('../../src/shared/ipc')
const { TmuxAdapter } = await import('../../src/main/tmux/adapter')
const { SessionManager } = await import('../../src/main/sessions/manager')
const { ConfigStore } = await import('../../src/main/state/store')
const { registerIpc } = await import('../../src/main/ipc/register')
const { StatusRegistry } = await import('../../src/main/status/registry')

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...(args as never[])) as Promise<T>
}

let configDir: string
let projectCwd: string
const saved = { config: process.env.PRCLI_CONFIG_DIR, zshrc: process.env.PRCLI_ZSHRC }

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'prcli-history-ipc-'))
  // Never a real directory: selectHistory only compares this against the
  // cwd string stored in each entry, so nothing here needs to exist on disk.
  projectCwd = join(configDir, 'project')
  // Both seams set even though these tests never touch the install/uninstall
  // channels: registerIpc wires all four together, and PRCLI_ZSHRC keeps any
  // future addition to this file from reaching the developer's real rc file.
  process.env.PRCLI_CONFIG_DIR = configDir
  process.env.PRCLI_ZSHRC = join(configDir, '.zshrc')

  ipc.handlers.clear()
  const manager = new SessionManager(new TmuxAdapter({ socket: 'prcli-history-ipc-test' }))
  const registry = new StatusRegistry()
  const store = new ConfigStore(join(configDir, 'config.json'))
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: () => undefined },
  }
  registerIpc(manager, () => fakeWindow as never, registry, store)
})

afterEach(async () => {
  process.env.PRCLI_CONFIG_DIR = saved.config
  process.env.PRCLI_ZSHRC = saved.zshrc
  await rm(configDir, { recursive: true, force: true })
})

describe('CHANNELS.historyList', () => {
  it('returns this project\'s commands, newest first', async () => {
    await writeFile(join(configDir, 'history.jsonl'), [
      JSON.stringify({ ts: 1, cwd: projectCwd, tab: 't', cmd: 'npm test' }),
      JSON.stringify({ ts: 2, cwd: '/elsewhere', tab: 't', cmd: 'other' }),
      JSON.stringify({ ts: 3, cwd: projectCwd, tab: 't', cmd: 'git push' }),
      '',
    ].join('\n'))

    const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'project')
    expect(entries.map((e) => e.cmd)).toEqual(['git push', 'npm test'])
  })

  it('returns an empty list rather than throwing when no history file exists', async () => {
    const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'project')
    expect(entries).toEqual([])
  })

  it('widens to every project when asked', async () => {
    await writeFile(join(configDir, 'history.jsonl'),
      `${JSON.stringify({ ts: 1, cwd: '/elsewhere', tab: 't', cmd: 'other' })}\n`)
    const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'all')
    expect(entries.map((e) => e.cmd)).toEqual(['other'])
  })

  // The design spec's Testing section calls for this at the IPC layer, not
  // only at parseHistory's own unit level: the file this channel reads is
  // appended to by a live shell, so a half-written last line is the ordinary
  // state of the world, and the composed path from channel to disk has to
  // survive it, not merely the helper in isolation.
  it('skips a malformed line rather than failing the read', async () => {
    await writeFile(join(configDir, 'history.jsonl'), [
      JSON.stringify({ ts: 1, cwd: projectCwd, tab: 't', cmd: 'npm test' }),
      'not json',
      JSON.stringify({ ts: 2, cwd: projectCwd, tab: 't', cmd: 'git push' }),
      '',
    ].join('\n'))

    const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'project')
    expect(entries.map((e) => e.cmd)).toEqual(['git push', 'npm test'])
  })
})
