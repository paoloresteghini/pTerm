import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  historyPath,
  parseHistory,
  readHistory,
  selectHistory,
  type HistoryEntry,
} from '../../src/main/shell/history'

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  ts: 1,
  cwd: '/Users/x/Code/PRCLI',
  tab: 'tab1',
  cmd: 'ls',
  ...over,
})

describe('parseHistory', () => {
  it('reads one entry per line', () => {
    const text = '{"ts":1,"cwd":"/a","tab":"t","cmd":"ls"}\n{"ts":2,"cwd":"/a","tab":"t","cmd":"pwd"}\n'
    expect(parseHistory(text).map((e) => e.cmd)).toEqual(['ls', 'pwd'])
  })

  // A half-written line is the normal state of a file being appended to by a
  // live shell, so it must cost that line and nothing else.
  it('skips a malformed line rather than failing the whole read', () => {
    const text = '{"ts":1,"cwd":"/a","tab":"t","cmd":"ls"}\nnot json\n{"ts":2,"cwd":"/a","tab":"t","cmd":"pwd"}\n'
    expect(parseHistory(text).map((e) => e.cmd)).toEqual(['ls', 'pwd'])
  })

  it('skips a line that parses but is not a history entry', () => {
    expect(parseHistory('{"ts":1}\n[]\n"str"\n')).toEqual([])
  })
})

describe('selectHistory', () => {
  const project = '/Users/x/Code/PRCLI'

  it('returns newest first', () => {
    const got = selectHistory(
      [entry({ ts: 1, cmd: 'first' }), entry({ ts: 2, cmd: 'second' })],
      { scope: 'all', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['second', 'first'])
  })

  it('keeps only the current project when scope is project, including subdirectories', () => {
    const got = selectHistory(
      [
        entry({ ts: 1, cwd: project, cmd: 'inRoot' }),
        entry({ ts: 2, cwd: `${project}/src/main`, cmd: 'inSub' }),
        entry({ ts: 3, cwd: '/Users/x/Code/Lumio', cmd: 'elsewhere' }),
      ],
      { scope: 'project', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['inSub', 'inRoot'])
  })

  // A sibling directory whose name merely starts with the project's must not
  // match. The separator is the whole of the check.
  it('does not treat a sibling with a shared prefix as inside the project', () => {
    const got = selectHistory(
      [entry({ ts: 1, cwd: `${project}-old`, cmd: 'sibling' })],
      { scope: 'project', projectCwd: project },
    )
    expect(got).toEqual([])
  })

  it('ignores the project when scope is all', () => {
    const got = selectHistory(
      [entry({ ts: 1, cwd: '/somewhere/else', cmd: 'elsewhere' })],
      { scope: 'all', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['elsewhere'])
  })

  it('filters by case-insensitive substring', () => {
    const got = selectHistory(
      [entry({ ts: 1, cmd: 'git push' }), entry({ ts: 2, cmd: 'npm test' })],
      { scope: 'all', projectCwd: project, filter: 'GIT' },
    )
    expect(got.map((e) => e.cmd)).toEqual(['git push'])
  })

  it('dedupes repeated commands, keeping the most recent', () => {
    const got = selectHistory(
      [entry({ ts: 1, cmd: 'npm test' }), entry({ ts: 2, cmd: 'ls' }), entry({ ts: 3, cmd: 'npm test' })],
      { scope: 'all', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['npm test', 'ls'])
    expect(got[0].ts).toBe(3)
  })

  it('caps the result at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => entry({ ts: i, cmd: `cmd${i}` }))
    expect(selectHistory(many, { scope: 'all', projectCwd: project, limit: 3 })).toHaveLength(3)
  })
})

describe('readHistory', () => {
  // configRoot() reads PRCLI_CONFIG_DIR at call time, the same seam
  // notes.test.ts and prompts.test.ts use to keep this test off the real
  // ~/.prcli.
  let dir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-history-'))
    previousConfigDir = process.env.PRCLI_CONFIG_DIR
    process.env.PRCLI_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.PRCLI_CONFIG_DIR
    else process.env.PRCLI_CONFIG_DIR = previousConfigDir
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty array when the history file does not exist', async () => {
    expect(await readHistory()).toEqual([])
  })

  it('bounds the read to the trailing limit lines', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify(entry({ ts: i, cmd: `cmd${i}` })))
    await writeFile(historyPath(), `${lines.join('\n')}\n`, 'utf8')

    const got = await readHistory(3)
    expect(got.map((e) => e.cmd)).toEqual(['cmd7', 'cmd8', 'cmd9'])
  })
})
