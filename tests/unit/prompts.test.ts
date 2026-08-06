import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPrompt, promptsPath, readPrompts, removePrompt } from '../../src/main/prompts/store'

// Same env pairing `notes.test.ts` uses: the store reads PRCLI_CONFIG_DIR at
// call time, so pointing it at a temp dir per test is what keeps this off the
// developer's real ~/.prcli.
let dir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-prompts-'))
  previousConfigDir = process.env.PRCLI_CONFIG_DIR
  process.env.PRCLI_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.PRCLI_CONFIG_DIR
  else process.env.PRCLI_CONFIG_DIR = previousConfigDir
  await rm(dir, { recursive: true, force: true })
})

describe('readPrompts', () => {
  it('resolves to an empty list when nothing has been saved', async () => {
    expect(await readPrompts()).toEqual([])
  })

  it('resolves to an empty list for a damaged file rather than rejecting', async () => {
    await writeFile(promptsPath(), '{ not json')
    expect(await readPrompts()).toEqual([])
  })

  it('drops only the malformed entries, keeping the rest', async () => {
    // The point of validating per entry rather than per file: one bad hand
    // edit must not cost the user every other prompt they saved.
    await writeFile(
      promptsPath(),
      JSON.stringify({
        prompts: [
          { id: 'a', label: 'Handover', body: 'give me a handover prompt' },
          { id: 'b', label: 'No body' },
          { label: 'No id', body: 'x' },
          null,
          { id: 'c', label: 'Review', body: 'review this diff' },
        ],
      }),
    )
    expect((await readPrompts()).map((entry) => entry.id)).toEqual(['a', 'c'])
  })
})

describe('addPrompt', () => {
  it('appends, and answers with the list as written', async () => {
    const first = await addPrompt('Handover', 'give me a handover prompt')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ label: 'Handover', body: 'give me a handover prompt' })

    const second = await addPrompt('Review', 'review this diff')
    // Oldest first, and the reply is the whole list rather than the new entry.
    expect(second.map((entry) => entry.label)).toEqual(['Handover', 'Review'])
    expect(await readPrompts()).toEqual(second)
  })

  it('mints an id per entry, so two prompts sharing a label stay distinct', async () => {
    await addPrompt('Same', 'one')
    const both = await addPrompt('Same', 'two')
    expect(both[0].id).not.toBe(both[1].id)
  })

  it('creates the config directory and leaves no temp file behind', async () => {
    const nested = join(dir, 'not-made-yet')
    process.env.PRCLI_CONFIG_DIR = nested
    await addPrompt('Handover', 'body')
    // One entry, and it is the file itself: the atomic write's temp was
    // renamed away rather than left in the directory.
    expect(await readdir(nested)).toEqual(['prompts.json'])
  })

  it('writes JSON a human can edit, which is the point of a file of its own', async () => {
    await addPrompt('Handover', 'body')
    expect(await readFile(promptsPath(), 'utf8')).toContain('\n  "prompts"')
  })

  /**
   * The reason the store has a queue at all.
   *
   * Both mutations are read-modify-write. Measured 2026-08-05 with `serialise`
   * reduced to `const next = work()`: this test and the delete one below both
   * failed, on
   * `ENOENT: no such file or directory, rename '…/prompts.json.<pid>.tmp'`,
   * because the atomic write names its temp file after the process and two
   * concurrent writes in one process therefore fight over the same path:
   * the first rename takes it and the second finds nothing to rename.
   *
   * Worth naming precisely, because it is NOT the failure the queue exists to
   * stop. A lost update (the second add reading the file before the first had
   * written it) is silent: the losing caller gets a resolved promise and a
   * list that looks right. Here the same race is loud only by luck of the
   * shared temp name, and a per-call temp name would turn it back into the
   * silent one. The queue is what actually rules both out.
   */
  it('keeps both entries when two adds are started together', async () => {
    const [, second] = await Promise.all([addPrompt('One', 'a'), addPrompt('Two', 'b')])
    expect(second).toHaveLength(2)
    expect((await readPrompts()).map((entry) => entry.label).sort()).toEqual(['One', 'Two'])
  })
})

describe('removePrompt', () => {
  it('drops the named entry and answers with what is left', async () => {
    await addPrompt('Handover', 'a')
    const both = await addPrompt('Review', 'b')
    const left = await removePrompt(both[0].id)
    expect(left.map((entry) => entry.label)).toEqual(['Review'])
    expect(await readPrompts()).toEqual(left)
  })

  it('leaves the file untouched for an id nothing knows about', async () => {
    await addPrompt('Handover', 'a')
    const before = await readFile(promptsPath(), 'utf8')
    expect(await removePrompt('no-such-id')).toHaveLength(1)
    expect(await readFile(promptsPath(), 'utf8')).toBe(before)
  })

  it('is serialised against add, so a delete cannot resurrect a concurrent one', async () => {
    const [first] = await addPrompt('Handover', 'a')
    const [, left] = await Promise.all([addPrompt('Review', 'b'), removePrompt(first.id)])
    expect(left.map((entry) => entry.label)).toEqual(['Review'])
    expect(await readPrompts()).toEqual(left)
  })
})
