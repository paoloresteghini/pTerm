import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// afterEach both removes the temp dir and restores PRCLI_CONFIG_DIR, the same
// pairing store.test.ts uses.
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNote, writeNote } from '../../src/main/notes/store'

let dir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-notes-'))
  previousConfigDir = process.env.PRCLI_CONFIG_DIR
  process.env.PRCLI_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.PRCLI_CONFIG_DIR
  else process.env.PRCLI_CONFIG_DIR = previousConfigDir
  await rm(dir, { recursive: true, force: true })
})

describe('readNote', () => {
  it('resolves to the empty string when no note file exists', async () => {
    expect(await readNote('p1')).toBe('')
  })

  it('resolves to the empty string for an id containing a slash', async () => {
    expect(await readNote('../../etc/passwd')).toBe('')
  })
})

describe('writeNote', () => {
  it('roundtrips text through the notes directory', async () => {
    await writeNote('p1', 'startup: npm run dev')
    expect(await readNote('p1')).toBe('startup: npm run dev')
  })

  it('creates the notes directory on first write, and only the note file', async () => {
    await writeNote('p1', 'x')
    // One entry, and it is the note itself: also proves the temp file used by
    // the atomic write was renamed away rather than left behind.
    expect(await readdir(join(dir, 'notes'))).toEqual(['p1.md'])
  })

  it('overwrites an existing note rather than appending', async () => {
    await writeNote('p1', 'first')
    await writeNote('p1', 'second')
    expect(await readNote('p1')).toBe('second')
  })

  it('is a no-op for an id containing ..', async () => {
    await writeNote('..', 'refused')
    // The refusal happens before mkdir, so the directory never appears.
    await expect(readdir(join(dir, 'notes'))).rejects.toThrow()
  })

  it('preserves an empty string as an empty note', async () => {
    await writeNote('p1', 'something')
    await writeNote('p1', '')
    expect(await readNote('p1')).toBe('')
  })
})
