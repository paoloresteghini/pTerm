import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreWorkspace } from '../../src/main/ipc/restore'
import { ConfigStore } from '../../src/main/state/store'
import type { SessionManager, PaneRecord, OpenInput } from '../../src/main/sessions/manager'

/** The config write queue. Nothing here contends for it, so running each
 *  operation immediately is equivalent to the real serialised queue. */
const immediate = <T>(operation: () => Promise<T>): Promise<T> => operation()

/**
 * A store over a fresh file holding these pane rows, and the path it is over
 * so a test can read back what restore actually wrote.
 *
 * Written at the version the rows are for: v5 has no `title` field, and a v6
 * file is the only way to put one on disk ahead of a restore.
 */
async function configHolding(
  version: 5 | 6,
  panes: PaneRecord[],
): Promise<{ store: ConfigStore; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-unit-'))
  const file = join(dir, 'config.json')
  await writeFile(
    file,
    JSON.stringify({ version, projects: [], activeProjectId: null, panes, tabs: [] }),
    'utf8',
  )
  return { store: new ConfigStore(file), file }
}

async function emptyConfig(): Promise<ConfigStore> {
  return (await configHolding(5, [])).store
}

function pane(id: string): PaneRecord {
  return { id, projectSlug: 'lumio', cwd: tmpdir(), tmuxSession: `prcli-lumio-${id}`, type: 'shell' }
}

/**
 * A fake SessionManager, standing in for real tmux.
 *
 * `restoreWorkspace` calls exactly three things on the manager it is given:
 * `detachAll`, `findOrphanTabs` and `open` — `withoutSharedWindows` also
 * reaches for `windowOfMember`, but only once a tab has two or more live
 * panes, and every tab here has one. Casting through `unknown` is deliberate:
 * `SessionManager` holds a private `adapter` field, which makes it nominally
 * typed, so no object literal satisfies it structurally — and standing up a
 * real `TmuxAdapter` is exactly the tmux/pty dependency this test exists to
 * avoid (restore's only other coverage, `tests/integration/restore.test.ts`,
 * pays that cost; this file drives the same function without it).
 */
function fakeManager(records: PaneRecord[], failing: ReadonlySet<string>): SessionManager {
  return {
    detachAll() {},
    async findOrphanTabs() {
      return records.map((record) => ({ tabId: record.id, panes: [record] }))
    },
    open(input: OpenInput): PaneRecord {
      if (input.id !== undefined && failing.has(input.id)) {
        throw new Error(`attach refused for ${input.id}`)
      }
      return {
        id: input.id ?? 'new',
        projectSlug: input.projectSlug,
        cwd: input.cwd,
        command: input.command,
        tmuxSession: `prcli-${input.projectSlug}-${input.id}`,
        type: input.type ?? 'shell',
      }
    },
  } as unknown as SessionManager
}

describe('restoreWorkspace: a pane that will not attach', () => {
  it('warns naming the pane, and the other panes still restore', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await emptyConfig()
      const manager = fakeManager(
        [pane('good1'), pane('bad2'), pane('good3')],
        new Set(['bad2']),
      )

      const result = await restoreWorkspace(manager, store, immediate)

      // The one pane that could not attach is the only one missing — the
      // decision to `continue` past it, not fail the whole restore, is the
      // half of this that must never regress.
      expect(result.panes.map((p) => p.id)).toEqual(['good1', 'good3'])

      // And the failure is no longer silent: exactly one warning, naming the
      // pane that was dropped.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0].join(' ')).toContain('bad2')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('restoreWorkspace: a saved title', () => {
  it('survives two consecutive restores against the same file', async () => {
    const named = { ...pane('named1'), title: 'payments api' }
    const { store, file } = await configHolding(6, [named])
    const manager = fakeManager([named], new Set())

    // Two, not one. One restore passes even when the write persists the
    // untitled panes `manager.open()` returned, because the reply it is
    // asserted on is patched separately from the file. The erasure only shows
    // when a second restore has to read back what the first one wrote, which
    // is every relaunch after the first, and every ⌘R reload in between.
    const first = await restoreWorkspace(manager, store, immediate)
    expect(first.panes.map((p) => p.title)).toEqual(['payments api'])

    // Read the file itself between the two, so a failure says whether the
    // title was lost on the way out or on the way back in.
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { panes: PaneRecord[] }
    expect(onDisk.panes.map((row) => row.title)).toEqual(['payments api'])

    const second = await restoreWorkspace(manager, store, immediate)
    expect(second.panes.map((p) => p.title)).toEqual(['payments api'])
  })
})
