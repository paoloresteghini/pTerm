/**
 * The two file tree operations that write to disk, against a real directory.
 *
 * `tests/unit/fileOps.test.ts` covers where they are ALLOWED to write, which is
 * pure path arithmetic. This covers what they actually do when they get there,
 * and in particular the two refusals that exist to stop data being destroyed:
 * a rename must not replace an existing file, and a create must not truncate
 * one. Both of those are properties of the syscall flags, so neither can be
 * checked without touching a filesystem.
 *
 * `shell.trashItem`, `shell.showItemInFolder` and `clipboard` are deliberately
 * not here: they are Electron surfaces with no test double, which is why the
 * handlers keep them as one-liners over the path logic tested above.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEntry, renameEntry } from '../../src/main/files/ops'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pterm-ops-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'contents of a', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = async (relPath: string): Promise<boolean> =>
  stat(join(root, relPath)).then(
    () => true,
    () => false,
  )

describe('renameEntry', () => {
  it('renames a file and leaves its contents alone', async () => {
    expect(await renameEntry(root, 'src/a.ts', 'b.ts')).toEqual({ ok: true })
    expect(await exists('src/a.ts')).toBe(false)
    expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('contents of a')
  })

  it('renames a directory', async () => {
    expect(await renameEntry(root, 'src', 'lib')).toEqual({ ok: true })
    expect(await exists('lib/a.ts')).toBe(true)
  })

  /*
   * The one that matters. `rename(2)` replaces its destination without a word,
   * so without the check in front of it a mistyped name silently destroys
   * whatever it collided with. Asserted by reading the victim back.
   */
  it('refuses to replace an existing file, and leaves it intact', async () => {
    await writeFile(join(root, 'src', 'b.ts'), 'contents of b', 'utf8')
    const result = await renameEntry(root, 'src/a.ts', 'b.ts')
    expect(result.ok).toBe(false)
    expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('contents of b')
    // And the source is still there, so nothing was lost either way.
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('contents of a')
  })

  it('accepts a rename to the same name as a no-op', async () => {
    expect(await renameEntry(root, 'src/a.ts', 'a.ts')).toEqual({ ok: true })
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('contents of a')
  })

  it('reports a missing source rather than throwing', async () => {
    const result = await renameEntry(root, 'src/gone.ts', 'b.ts')
    expect(result.ok).toBe(false)
  })

  // The path guard, exercised against a real tree rather than only in the unit
  // test: a traversal must not move a file out of the project.
  it('refuses a name that would move the file out of the project', async () => {
    const result = await renameEntry(root, 'src/a.ts', '../../escaped.ts')
    expect(result.ok).toBe(false)
    expect(await exists('src/a.ts')).toBe(true)
  })
})

describe('createEntry', () => {
  it('creates an empty file', async () => {
    expect(await createEntry(root, 'src', 'new.ts', 'file')).toEqual({ ok: true })
    expect(await readFile(join(root, 'src', 'new.ts'), 'utf8')).toBe('')
  })

  it('creates a directory', async () => {
    expect(await createEntry(root, 'src', 'nested', 'directory')).toEqual({ ok: true })
    expect((await stat(join(root, 'src', 'nested'))).isDirectory()).toBe(true)
  })

  it('creates at the project root', async () => {
    expect(await createEntry(root, '', 'top.ts', 'file')).toEqual({ ok: true })
    expect(await exists('top.ts')).toBe(true)
  })

  /*
   * The second data-destroying case. An `open` without `wx` truncates, so a
   * New File onto an existing name would empty it. Asserted by reading the
   * contents back rather than by trusting the returned error.
   */
  it('refuses an existing file, and does not truncate it', async () => {
    const result = await createEntry(root, 'src', 'a.ts', 'file')
    expect(result.ok).toBe(false)
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('contents of a')
  })

  it('refuses an existing directory', async () => {
    const result = await createEntry(root, '', 'src', 'directory')
    expect(result.ok).toBe(false)
    // And the directory it refused still holds what it did before.
    expect(await exists('src/a.ts')).toBe(true)
  })

  it('refuses to create outside the project', async () => {
    const result = await createEntry(root, '../..', 'escaped.ts', 'file')
    expect(result.ok).toBe(false)
  })
})
