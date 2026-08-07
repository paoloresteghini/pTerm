import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCandidates, projectsRoot } from '../../src/main/projects/discovery'

let root: string
const original = process.env.PTERM_PROJECTS_ROOT

beforeEach(async () => {
  // Never scan the developer's real ~/Code, for the same reason tests never
  // touch the real ~/.pterm.
  root = await mkdtemp(join(tmpdir(), 'pterm-scan-'))
  process.env.PTERM_PROJECTS_ROOT = root
})

afterEach(async () => {
  if (original === undefined) delete process.env.PTERM_PROJECTS_ROOT
  else process.env.PTERM_PROJECTS_ROOT = original
  await rm(root, { recursive: true, force: true })
})

async function repo(name: string, marker: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (marker === '.git') await mkdir(join(dir, '.git'))
  else await writeFile(join(dir, marker), '{}', 'utf8')
  return dir
}

describe('projectsRoot', () => {
  it('honours PTERM_PROJECTS_ROOT', () => {
    expect(projectsRoot()).toBe(root)
  })

  it('falls back to ~/Code', () => {
    delete process.env.PTERM_PROJECTS_ROOT
    expect(projectsRoot()).toMatch(/\/Code$/)
  })
})

describe('scanCandidates', () => {
  it('finds a git repository', async () => {
    await repo('lumio', '.git')
    await expect(scanCandidates([]).then((c) => c.map((e) => e.name))).resolves.toEqual(['lumio'])
  })

  it('finds a node project and a php one', async () => {
    await repo('web', 'package.json')
    await repo('api', 'composer.json')
    const names = (await scanCandidates([])).map((c) => c.name)
    expect(names.sort()).toEqual(['api', 'web'])
  })

  it('reports which markers it matched on', async () => {
    await repo('lumio', '.git')
    await writeFile(join(root, 'lumio', 'package.json'), '{}', 'utf8')
    const [candidate] = await scanCandidates([])
    expect(candidate.markers.sort()).toEqual(['.git', 'package.json'])
  })

  it('ignores a directory with no marker', async () => {
    await mkdir(join(root, 'notes'))
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('ignores loose files at the root', async () => {
    await writeFile(join(root, 'todo.txt'), 'x', 'utf8')
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('does not descend past one level', async () => {
    await mkdir(join(root, 'clients', 'lumio', '.git'), { recursive: true })
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('excludes folders that are already projects', async () => {
    const lumio = await repo('lumio', '.git')
    await repo('adecco', '.git')
    await expect(scanCandidates([lumio]).then((c) => c.map((e) => e.name))).resolves.toEqual([
      'adecco',
    ])
  })

  it('sorts by name so the picker is stable', async () => {
    await repo('zeta', '.git')
    await repo('alpha', '.git')
    await expect(scanCandidates([]).then((c) => c.map((e) => e.name))).resolves.toEqual([
      'alpha',
      'zeta',
    ])
  })

  it('returns nothing when the root does not exist', async () => {
    process.env.PTERM_PROJECTS_ROOT = join(root, 'gone')
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('skips dotfile directories', async () => {
    await repo('.cache', '.git')
    await expect(scanCandidates([])).resolves.toEqual([])
  })
})
