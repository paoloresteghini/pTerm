import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir, readFileInside, writeFileInside, type WriteResult } from '../../src/main/files/tree'

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

async function handleRead(
  projects: { id: string; cwd: string }[],
  projectId: string,
  relPath: string,
): Promise<{ text: string; mtimeMs: number } | null> {
  const project = projects.find((row) => row.id === projectId)
  if (!project) return null
  return readFileInside(project.cwd, relPath)
}

describe('the fsRead handler', () => {
  it('reads a file from the named project', async () => {
    const found = await handleRead([{ id: 'p1', cwd: root }], 'p1', 'README.md')
    expect(found?.text).toBe('#')
  })

  it('resolves an unknown project to null rather than throwing', async () => {
    await expect(handleRead([{ id: 'p1', cwd: root }], 'nope', 'README.md')).resolves.toBeNull()
  })

  it('will not read outside the project it names', async () => {
    await expect(handleRead([{ id: 'p1', cwd: root }], 'p1', '../../etc/hosts')).resolves.toBeNull()
  })
})

async function handleWrite(
  projects: { id: string; cwd: string }[],
  projectId: string,
  relPath: string,
  text: string,
  expectedMtimeMs: number,
): Promise<WriteResult> {
  const project = projects.find((row) => row.id === projectId)
  if (!project) return { ok: false, reason: 'failed' }
  return writeFileInside(project.cwd, relPath, text, expectedMtimeMs)
}

describe('the fsWrite handler', () => {
  it('writes a file of the named project', async () => {
    const before = await readFileInside(root, 'README.md')
    const result = await handleWrite([{ id: 'p1', cwd: root }], 'p1', 'README.md', '# two', before!.mtimeMs)
    expect(result.ok).toBe(true)
    expect((await readFileInside(root, 'README.md'))?.text).toBe('# two')
  })

  it('resolves an unknown project to a refusal rather than throwing', async () => {
    const result = await handleWrite([{ id: 'p1', cwd: root }], 'nope', 'README.md', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })

  it('will not write outside the project it names', async () => {
    const result = await handleWrite([{ id: 'p1', cwd: root }], 'p1', '../../tmp/escaped.txt', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })
})
