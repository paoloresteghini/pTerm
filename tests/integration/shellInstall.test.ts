import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises'
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
const saved = { zshrc: process.env.PRCLI_ZSHRC, config: process.env.PRCLI_CONFIG_DIR }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-shell-inst-'))
  rc = join(dir, '.zshrc')
  await writeFile(rc, 'export PATH=/usr/bin\n', 'utf8')
  process.env.PRCLI_ZSHRC = rc
  process.env.PRCLI_CONFIG_DIR = dir
})

afterEach(async () => {
  process.env.PRCLI_ZSHRC = saved.zshrc
  process.env.PRCLI_CONFIG_DIR = saved.config
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
    expect(await readFile(state.scriptPath, 'utf8')).toContain('PRCLI_HISTORY_FILE')
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

    await expect(readFile(installed.scriptPath, 'utf8')).resolves.toContain('PRCLI_HISTORY_FILE')
  })

  it('does nothing to an rc file it never touched', async () => {
    const before = await readFile(rc, 'utf8')
    await uninstallShellHistory()
    expect(await readFile(rc, 'utf8')).toBe(before)
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
