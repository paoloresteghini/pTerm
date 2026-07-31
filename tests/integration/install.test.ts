import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmod, mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `vi.spyOn` cannot redefine a named export of a real ESM built-in — Node's
// module namespace objects are not configurable. A one-shot override lets a
// single test force `copyFile` to fail without touching every other call
// this file and `install.ts` both make through the same module.
const copyFileControl = vi.hoisted(() => ({
  next: null as ((...args: unknown[]) => Promise<void>) | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    copyFile: (...args: unknown[]) => {
      const override = copyFileControl.next
      if (override) {
        copyFileControl.next = null
        return override(...args)
      }
      return (actual.copyFile as (...args: unknown[]) => Promise<void>)(...args)
    },
  }
})

const { installHooks, readHooksState, uninstallHooks } = await import('../../src/main/hooks/install')

let dir: string
let settings: string
const saved = { config: process.env.PRCLI_CONFIG_DIR, claude: process.env.PRCLI_CLAUDE_SETTINGS }

const ORIGINAL = {
  model: 'opusplan',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
  },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-inst-'))
  settings = join(dir, 'settings.json')
  await writeFile(settings, `${JSON.stringify(ORIGINAL, null, 2)}\n`, 'utf8')
  process.env.PRCLI_CONFIG_DIR = dir
  process.env.PRCLI_CLAUDE_SETTINGS = settings
})

afterEach(async () => {
  process.env.PRCLI_CONFIG_DIR = saved.config
  process.env.PRCLI_CLAUDE_SETTINGS = saved.claude
  copyFileControl.next = null
  await rm(dir, { recursive: true, force: true })
})

describe('installHooks', () => {
  it('reports not installed, and what it would add, before anything happens', async () => {
    const state = await readHooksState()

    expect(state.installed).toBe(false)
    expect(state.pending).toContain('prcli-hook')
    // The diff the screen shows comes from the same merge that writes.
    expect(JSON.parse(state.pending)).toBeTypeOf('object')
  })

  it('names an existing afplay hook as a sound collision', async () => {
    const state = await readHooksState()
    expect(state.collisions.map((c) => c.event)).toEqual(['Stop'])
  })

  it('writes a timestamped backup before touching the file', async () => {
    await installHooks()

    const backups = (await readdir(dir)).filter((name) => name.startsWith('settings.json.'))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, backups[0] ?? ''), 'utf8'))).toEqual(ORIGINAL)
  })

  it('installs the script, executable', async () => {
    const state = await installHooks()

    const info = await stat(state.hookPath)
    expect(info.isFile()).toBe(true)
    // Claude executes this directly; a non-executable file fails every hook.
    expect(info.mode & 0o111).toBeGreaterThan(0)
    expect(await readFile(state.hookPath, 'utf8')).toContain('#!/bin/sh')
  })

  it('is idempotent', async () => {
    await installHooks()
    const after = await readFile(settings, 'utf8')

    const state = await installHooks()

    expect(state.installed).toBe(true)
    expect(await readFile(settings, 'utf8')).toBe(after)
  })

  it('restores the original file on uninstall', async () => {
    await installHooks()

    const state = await uninstallHooks()

    expect(state.installed).toBe(false)
    // Byte-for-byte the object it found. This is the assertion that protects
    // every other Claude session on the machine.
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual(ORIGINAL)
  })

  // Stronger than the assertion above: the file this fixture starts from was
  // written with the same 2-space-indent-plus-trailing-newline formatting
  // every write in this module uses, so a correct key-order-preserving
  // round trip should reproduce it byte for byte, not just structurally.
  it('restores the file byte-identical, not merely structurally equal', async () => {
    const before = await readFile(settings, 'utf8')

    await installHooks()
    await uninstallHooks()

    expect(await readFile(settings, 'utf8')).toBe(before)
  })

  it('refuses a settings file it cannot parse, and writes nothing', async () => {
    await writeFile(settings, '{ not json', 'utf8')

    await expect(installHooks()).rejects.toThrow()

    expect(await readFile(settings, 'utf8')).toBe('{ not json')
  })

  it('creates a settings file when there is none', async () => {
    await rm(settings, { force: true })

    const state = await installHooks()

    expect(state.installed).toBe(true)
    expect(JSON.parse(await readFile(settings, 'utf8')).hooks).toBeTypeOf('object')
  })

  // A file that cannot be read at all — not "there is none" — is a second
  // way to reach the same catastrophe a parse failure is guarded against:
  // the brief's original `readSettings` caught every `readFile` error alike
  // and returned `{}`, which would have let `installHooks` sail past a
  // permission-denied *existing* file and overwrite it with a brand new one,
  // discarding whatever it actually held. Only ENOENT means there was
  // nothing to lose.
  it('refuses a settings file it cannot read, and writes nothing', async () => {
    await chmod(settings, 0o000)
    try {
      await expect(installHooks()).rejects.toThrow()
    } finally {
      await chmod(settings, 0o644)
    }
    expect(await readFile(settings, 'utf8')).toBe(`${JSON.stringify(ORIGINAL, null, 2)}\n`)
  })
})

/**
 * `readHooksState` powers the screen the Install button lives on. If it
 * swallowed a parse failure the way `installHooks` correctly refuses to, the
 * pane would render "not installed" with a working-looking Install button
 * that is certain to throw the moment it is pressed — a worse experience
 * than surfacing the same error the write path already reports honestly.
 */
describe('readHooksState on an unparseable file', () => {
  it('throws, rather than reporting "not installed" and offering a doomed Install', async () => {
    await writeFile(settings, '{ not json', 'utf8')

    await expect(readHooksState()).rejects.toThrow()
  })
})

/**
 * `copyFile(...).catch(() => undefined)`, as the brief's own version has it,
 * silently discards a backup failure and then proceeds to overwrite the
 * original settings file on the very next line — precisely the "worst thing
 * this module could do" the design already calls out for an unparseable
 * file. A backup that fails for any reason other than "there was nothing to
 * back up" must abort before the original is touched.
 */
describe('a backup that fails for a reason other than "nothing to back up"', () => {
  it('aborts installHooks before the original settings file is touched', async () => {
    const before = await readFile(settings, 'utf8')
    copyFileControl.next = () =>
      Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))

    await expect(installHooks()).rejects.toThrow(/permission denied/i)

    expect(await readFile(settings, 'utf8')).toBe(before)
  })

  it('aborts uninstallHooks before the original settings file is touched', async () => {
    await installHooks()
    const before = await readFile(settings, 'utf8')
    copyFileControl.next = () =>
      Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))

    await expect(uninstallHooks()).rejects.toThrow(/permission denied/i)

    expect(await readFile(settings, 'utf8')).toBe(before)
  })

  // The tolerated case: no settings file exists yet, so copyFile's ENOENT is
  // exactly what "nothing to back up" looks like, and must not abort.
  it('still installs when there truly is nothing to back up', async () => {
    await rm(settings, { force: true })

    const state = await installHooks()

    expect(state.installed).toBe(true)
  })
})
