import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installShellHistory,
  readShellHistoryState,
  uninstallShellHistory,
} from '../../src/main/shell/install'

// tests/unit/shellInstall.test.ts covers block/isInstalled/merge/unmerge as
// pure string functions. This file is the file-touching half: the actual
// read-modify-write round trip against a real rc file, the way Task 1's
// review found the plan's own test coverage had skipped for the equivalent
// hooks module before tests/integration/install.test.ts filled it in.

let dir: string
let rc: string
const saved = { zshrc: process.env.PTERM_ZSHRC, config: process.env.PTERM_CONFIG_DIR }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-shell-inst-'))
  rc = join(dir, '.zshrc')
  await writeFile(rc, 'export PATH=/usr/bin\n', 'utf8')
  process.env.PTERM_ZSHRC = rc
  process.env.PTERM_CONFIG_DIR = dir
})

afterEach(async () => {
  process.env.PTERM_ZSHRC = saved.zshrc
  process.env.PTERM_CONFIG_DIR = saved.config
  await rm(dir, { recursive: true, force: true })
})

describe('readShellHistoryState', () => {
  it('reports not installed before anything happens', async () => {
    const state = await readShellHistoryState()
    expect(state.installed).toBe(false)
    expect(state.rcPath).toBe(rc)
    expect(state.pending).toContain(state.scriptPath)
  })

  it('treats a missing rc file the same as an empty one, not an error', async () => {
    await rm(rc, { force: true })
    await expect(readShellHistoryState()).resolves.toMatchObject({ installed: false })
  })
})

describe('installShellHistory', () => {
  it('writes the sourcing snippet under configRoot()', async () => {
    const state = await installShellHistory()
    expect(await readFile(state.scriptPath, 'utf8')).toContain('PTERM_HISTORY_FILE')
  })

  it('appends the marker block to the rc file, keeping what was already there', async () => {
    const state = await installShellHistory()
    const written = await readFile(rc, 'utf8')
    expect(written.startsWith('export PATH=/usr/bin\n')).toBe(true)
    expect(written).toContain(state.scriptPath)
    expect(state.installed).toBe(true)
  })

  it('creates the rc file when there is none', async () => {
    await rm(rc, { force: true })
    const state = await installShellHistory()
    expect(state.installed).toBe(true)
    expect(await readFile(rc, 'utf8')).toContain(state.scriptPath)
  })

  it('is idempotent: a second install adds nothing further', async () => {
    await installShellHistory()
    const after = await readFile(rc, 'utf8')

    await installShellHistory()

    expect(await readFile(rc, 'utf8')).toBe(after)
  })
})

describe('uninstallShellHistory', () => {
  it('restores the rc file byte for byte', async () => {
    const before = await readFile(rc, 'utf8')

    await installShellHistory()
    const state = await uninstallShellHistory()

    expect(state.installed).toBe(false)
    expect(await readFile(rc, 'utf8')).toBe(before)
  })

  it('leaves the generated script on disk, so a reinstall needs no rewrite of it', async () => {
    const installed = await installShellHistory()
    await uninstallShellHistory()

    await expect(readFile(installed.scriptPath, 'utf8')).resolves.toContain('PTERM_HISTORY_FILE')
  })

  it('does nothing to an rc file it never touched', async () => {
    const before = await readFile(rc, 'utf8')
    await uninstallShellHistory()
    expect(await readFile(rc, 'utf8')).toBe(before)
  })
})

/** Every `<rc>.<timestamp>.bak` sitting beside the temp rc file. */
async function backups(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('.zshrc.') && name.endsWith('.bak'))
}

/*
 * `~/.zshrc` is a hand-tuned file that a user may have carried between
 * machines for years, and this app rewrites it whole. `writeFile` truncates
 * before it writes, so an interruption between those two leaves a shell that
 * no longer starts. The hooks module has taken this precaution since it was
 * written; the design doc says this module was modelled on it, and until now
 * this was the one part of that shape it did not copy.
 */
describe('the rc file is copied aside before it is rewritten', () => {
  it('keeps what the rc file held before an install', async () => {
    await installShellHistory()

    const found = await backups()
    expect(found).toHaveLength(1)
    expect(await readFile(join(dir, found[0]), 'utf8')).toBe('export PATH=/usr/bin\n')
  })

  it('keeps what the rc file held before an uninstall', async () => {
    await installShellHistory()
    const installed = await readFile(rc, 'utf8')

    await uninstallShellHistory()

    // Asked as "is the installed text in one of these" rather than by counting
    // or by picking the newest. `backupIfPresent` names its copy after
    // `Date.now()`, and an install followed immediately by an uninstall can
    // land in the same millisecond, in which case the second copy replaces the
    // first instead of joining it. The claim being made here survives that;
    // an assertion on the count would fail once in a while for a reason that
    // has nothing to do with what it is testing.
    const contents = await Promise.all(
      (await backups()).map((name) => readFile(join(dir, name), 'utf8')),
    )
    expect(contents).toContain(installed)
  })

  // Without this, every click of a disabled-looking Install button would drop
  // another copy of an unchanged file into the user's home directory. It also
  // pins that the backup is tied to the WRITE and not to the call.
  it('writes no backup when the rc file already says what it would say', async () => {
    await installShellHistory()
    const afterInstall = (await backups()).sort()
    // Non-vacuous: the repeat assertions below would be satisfied by a build
    // that never backed anything up at all.
    expect(afterInstall).toHaveLength(1)

    await installShellHistory()
    expect((await backups()).sort()).toEqual(afterInstall)

    await uninstallShellHistory()
    const afterUninstall = (await backups()).sort()

    await uninstallShellHistory()
    expect((await backups()).sort()).toEqual(afterUninstall)
  })
})

/*
 * The history file records every command run in every shell pane, so it holds
 * whatever those commands held: tokens, connection strings, a one-off
 * `export SECRET=...`. zsh keeps its own `~/.zsh_history` at 0600 for that
 * reason. The hook creates this file by `>>` redirection, which lands at
 * `0666 & ~umask`, so on the default macOS `umask 022` it would otherwise be
 * 0644 and readable by every other account on the machine.
 */
describe('the history file is not left readable by other accounts', () => {
  const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

  it('creates it at 0600 so the hook has nothing to choose', async () => {
    const state = await installShellHistory()
    expect(await modeOf(state.historyFile)).toBe(0o600)
  })

  // The upgrade path: a file an earlier build left at 0644 is already on disk
  // and no amount of correct creation will fix it.
  it('tightens a file an earlier version left readable, keeping its contents', async () => {
    const { historyFile } = await readShellHistoryState()
    await writeFile(historyFile, '{"ts":1,"cwd":"/a","tab":"t","cmd":"ls"}\n', { mode: 0o644 })
    await chmod(historyFile, 0o644)

    await installShellHistory()

    expect(await modeOf(historyFile)).toBe(0o600)
    expect(await readFile(historyFile, 'utf8')).toContain('"cmd":"ls"')
  })
})

// A permission-denied rc file is not "no file" and must not be treated as
// one: doing so would let install/uninstall silently overwrite an existing,
// unreadable ~/.zshrc with just the new block, discarding everything it held.
describe('an rc file that exists but cannot be read', () => {
  it('refuses installShellHistory, and writes nothing', async () => {
    // Write-only, not no-access: 0o000 blocks the write too, which would
    // make installShellHistory/uninstallShellHistory fail regardless of how
    // readRc treats the read error, and the test would pass for the wrong
    // reason. 0o200 isolates the read failure the way a real unreadable
    // rc could still be writable, which is the case that actually risks
    // silent data loss if readRc mistook it for "no file".
    await chmod(rc, 0o200)
    try {
      await expect(installShellHistory()).rejects.toThrow()
    } finally {
      await chmod(rc, 0o644)
    }
    expect(await readFile(rc, 'utf8')).toBe('export PATH=/usr/bin\n')
  })

  it('refuses uninstallShellHistory, and writes nothing', async () => {
    // Write-only, not no-access: 0o000 blocks the write too, which would
    // make installShellHistory/uninstallShellHistory fail regardless of how
    // readRc treats the read error, and the test would pass for the wrong
    // reason. 0o200 isolates the read failure the way a real unreadable
    // rc could still be writable, which is the case that actually risks
    // silent data loss if readRc mistook it for "no file".
    await chmod(rc, 0o200)
    try {
      await expect(uninstallShellHistory()).rejects.toThrow()
    } finally {
      await chmod(rc, 0o644)
    }
    expect(await readFile(rc, 'utf8')).toBe('export PATH=/usr/bin\n')
  })
})
