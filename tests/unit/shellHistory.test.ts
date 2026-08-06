import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  historyPath,
  parseHistory,
  readHistory,
  selectHistory,
  type HistoryEntry,
} from '../../src/main/shell/history'
import { renderHistoryScript } from '../../src/main/shell/install'

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

const run = promisify(execFile)

/**
 * Spawns zsh against a throwaway `$ZDOTDIR` and `$HISTFILE`, sources the
 * rendered snippet in it, runs `command`, and returns whatever the snippet
 * wrote.
 *
 * `-i` alone is not enough: measured directly, `zsh -i -c '...; some-command'`
 * never calls `preexec` at all, because `-c` executes its argument as a
 * single batch string rather than feeding it through the interactive
 * read-eval loop that `preexec` hooks into. Feeding the source line and the
 * command as lines on stdin instead (the way a real terminal would type
 * them) does fire it, so that's what this does: `execFile`'s promisified
 * form exposes the live child on `promise.child`, which is what lets stdin
 * be written before the process has finished.
 *
 * Pointing `$ZDOTDIR` and `$HISTFILE` at a fresh temp directory keeps `-i`'s
 * usual side effects, reading a startup file and appending to a history
 * file, off the developer's real `~/.zshrc` and `~/.zsh_history`.
 */
async function recordViaZsh(commands: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-hist-'))
  const historyFile = join(dir, 'history.jsonl')
  const scriptFile = join(dir, 'prcli-history.zsh')
  await writeFile(scriptFile, renderHistoryScript(historyFile), 'utf8')
  const spawned = run('zsh', ['-i'], {
    env: {
      ...process.env,
      PRCLI_TAB_ID: 'tab-under-test',
      ZDOTDIR: dir,
      HISTFILE: join(dir, '.zsh_history'),
    },
  })
  spawned.child.stdin?.end(`source ${scriptFile}\n${commands.join('\n')}\nexit\n`)
  await spawned
  return readFile(historyFile, 'utf8')
}

describe('the zsh snippet', () => {
  it('records a command as a parseable entry carrying cwd and tab id', async () => {
    const written = await recordViaZsh(['true'])
    const entries = parseHistory(written)
    const recorded = entries.find((e) => e.cmd.includes('true'))
    expect(recorded).toBeDefined()
    expect(recorded?.tab).toBe('tab-under-test')
    expect(recorded?.cwd).not.toBe('')
    expect(recorded?.ts).toBeGreaterThan(0)
  }, 20_000)

  // What this guards against: an unescaped quote or backslash turns the
  // written line into invalid JSON, so parseHistory silently drops it and
  // the command never shows up in the overlay.
  it('escapes double quotes and backslashes so the line stays parseable', async () => {
    const written = await recordViaZsh([String.raw`echo "a\"b" > /dev/null`])
    const entries = parseHistory(written)
    expect(entries.some((e) => e.cmd.includes('echo'))).toBe(true)
  }, 20_000)

  /*
   * The one gesture people use to keep a secret out of a shell log.
   *
   * `preexec` fires for every interactive command, before and independently of
   * whether zsh will store it, so `HIST_IGNORE_SPACE` has no effect on what
   * this hook writes. Without the guard the hook now carries, a command
   * deliberately typed with a leading space would be absent from
   * `~/.zsh_history` and present in `history.jsonl`.
   *
   * Both commands run in one shell, and the plain one is asserted present. A
   * test that only checked for the absence of the spaced command would pass on
   * a hook that recorded nothing at all, which is a state this file has to be
   * able to tell apart from a working one.
   */
  it('does not record a command typed with a leading space', async () => {
    const written = await recordViaZsh([' echo prcli-spaced', 'echo prcli-plain'])
    const recorded = parseHistory(written).map((e) => e.cmd)
    expect(recorded).toContain('echo prcli-plain')
    expect(recorded.filter((cmd) => cmd.includes('prcli-spaced'))).toEqual([])
  }, 20_000)

  it('records nothing when PRCLI_TAB_ID is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prcli-hist-'))
    const historyFile = join(dir, 'history.jsonl')
    const scriptFile = join(dir, 'prcli-history.zsh')
    await writeFile(scriptFile, renderHistoryScript(historyFile), 'utf8')
    const { PRCLI_TAB_ID: _unused, ...rest } = process.env
    const env = { ...rest, ZDOTDIR: dir, HISTFILE: join(dir, '.zsh_history') }
    const spawned = run('zsh', ['-i'], { env })
    spawned.child.stdin?.end(`source ${scriptFile}\ntrue\nexit\n`)
    await spawned
    await expect(readFile(historyFile, 'utf8')).rejects.toThrow()
  }, 20_000)
})
