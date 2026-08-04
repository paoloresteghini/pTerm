import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir } from '../../src/main/files/tree'

/**
 * The handler's own logic, exercised without Electron: resolve a project id
 * against a config, then list. `ipcMain.handle` is not reachable from vitest,
 * so what is covered here is the lookup-then-list pair the handler performs,
 * and the e2e in `tests/e2e/filetree.spec.ts` is what drives the real channel.
 *
 * Stated rather than implied: this does NOT prove the channel is registered,
 * bridged in preload, or named consistently. Task 4's e2e is what proves that,
 * and deleting the `ipcMain.handle` call leaves this file green.
 */
async function handle(
  projects: { id: string; cwd: string }[],
  projectId: string,
  relPath: string,
): Promise<{ name: string; dir: boolean }[]> {
  const project = projects.find((row) => row.id === projectId)
  if (!project) return []
  return listDir(project.cwd, relPath)
}

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'prcli-tree-ipc-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), '#')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the fsList handler', () => {
  it('lists the named project', async () => {
    const entries = await handle([{ id: 'p1', cwd: root }], 'p1', '')
    expect(entries.map((entry) => entry.name)).toEqual(['src', 'README.md'])
  })

  it('resolves an unknown project to an empty list rather than throwing', async () => {
    await expect(handle([{ id: 'p1', cwd: root }], 'nope', '')).resolves.toEqual([])
  })

  // The containment guard reached through a project lookup, which is how it is
  // actually called.
  it('will not list outside the project it names', async () => {
    await expect(handle([{ id: 'p1', cwd: root }], 'p1', '../..')).resolves.toEqual([])
  })
})
