import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, mergePresets } from '../../src/main/projects/manifest'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-manifest-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function manifest(contents: string): Promise<void> {
  await writeFile(join(dir, '.prcli.json'), contents, 'utf8')
}

describe('readManifest', () => {
  it('reads the declared presets', async () => {
    await manifest(JSON.stringify({ presets: [{ label: 'dev', command: 'npm run dev' }] }))
    const presets = await readManifest(dir)
    expect(presets.map((p) => p.label)).toEqual(['dev'])
    expect(presets[0].command).toBe('npm run dev')
  })

  it('gives every preset an id, since the file carries none', async () => {
    await manifest(JSON.stringify({ presets: [{ label: 'dev', command: 'npm run dev' }] }))
    expect((await readManifest(dir))[0].id).toEqual(expect.any(String))
  })

  it('returns nothing when there is no manifest', async () => {
    await expect(readManifest(dir)).resolves.toEqual([])
  })

  // One bad file in one customer's repo must never stop the app starting.
  it('returns nothing for malformed JSON rather than throwing', async () => {
    await manifest('{not json')
    await expect(readManifest(dir)).resolves.toEqual([])
  })

  it('returns nothing when presets is not an array', async () => {
    await manifest(JSON.stringify({ presets: 'nope' }))
    await expect(readManifest(dir)).resolves.toEqual([])
  })

  it('drops entries that are not shaped like a preset', async () => {
    await manifest(
      JSON.stringify({ presets: [{ label: 'ok', command: 'x' }, { label: 'no command' }, null] }),
    )
    await expect(readManifest(dir).then((p) => p.map((e) => e.label))).resolves.toEqual(['ok'])
  })

  it('returns nothing when the directory does not exist', async () => {
    await expect(readManifest(join(dir, 'gone'))).resolves.toEqual([])
  })

  it('returns nothing when .prcli.json is a directory', async () => {
    await mkdir(join(dir, '.prcli.json'))
    await expect(readManifest(dir)).resolves.toEqual([])
  })
})

describe('mergePresets', () => {
  const user = [{ id: 'u1', label: 'dev', command: 'npm run dev -- --port 4000' }]
  const repo = [
    { id: 'r1', label: 'dev', command: 'npm run dev' },
    { id: 'r2', label: 'queue', command: 'php artisan queue:work' },
  ]

  it('lets the user override a repo preset with the same label', () => {
    const merged = mergePresets(user, repo)
    expect(merged.find((p) => p.label === 'dev')?.command).toBe('npm run dev -- --port 4000')
  })

  it('keeps repo presets the user has not overridden', () => {
    expect(mergePresets(user, repo).map((p) => p.label).sort()).toEqual(['dev', 'queue'])
  })

  it('tags where each came from, so the panel can show provenance', () => {
    const merged = mergePresets(user, repo)
    expect(merged.find((p) => p.label === 'dev')?.origin).toBe('user')
    expect(merged.find((p) => p.label === 'queue')?.origin).toBe('repo')
  })

  it('puts user presets first', () => {
    expect(mergePresets(user, repo)[0].label).toBe('dev')
  })

  it('handles either side being empty', () => {
    expect(mergePresets([], repo).map((p) => p.origin)).toEqual(['repo', 'repo'])
    expect(mergePresets(user, []).map((p) => p.origin)).toEqual(['user'])
  })
})
