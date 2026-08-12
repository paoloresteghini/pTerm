import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpPreferencePath, readMcpEnabled, writeMcpEnabled } from '../../src/main/mcp/enabled'

/**
 * The persisted half of the browser bridge's off switch, on its own.
 *
 * `PTERM_CONFIG_DIR` is what keeps every one of these off the real `~/.pterm`,
 * and it is the same variable the e2e harness already sets, so nothing new is
 * guarded and `tests/unit/e2eSafety.test.ts` still pins six. Exactly one test
 * below unsets it, to assert the fallback path, and that one computes a path
 * without opening it.
 */
const saved = process.env.PTERM_CONFIG_DIR

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-enabled-'))
  process.env.PTERM_CONFIG_DIR = dir
})

afterEach(async () => {
  if (saved === undefined) delete process.env.PTERM_CONFIG_DIR
  else process.env.PTERM_CONFIG_DIR = saved
  await rm(dir, { recursive: true, force: true })
})

describe('the browser bridge preference', () => {
  // The user's ruling: a machine where nobody has opened Settings behaves
  // exactly as it did before the switch existed.
  it('is on when nothing has ever been written', async () => {
    expect(await readMcpEnabled()).toBe(true)
  })

  /**
   * The relaunch property, as far as this module can state it: it holds no
   * state of its own, so a second `readMcpEnabled()` reads the file again and
   * is exactly what a fresh process does. Both directions are asserted:
   * write-then-read, so the write lands where the read looks, and a file
   * written by hand and then read, so the answer cannot be coming from
   * anything the writer left in memory.
   */
  it('is off on the next read after being turned off', async () => {
    await writeMcpEnabled(false)
    expect(await readMcpEnabled()).toBe(false)

    await writeMcpEnabled(true)
    expect(await readMcpEnabled()).toBe(true)
  })

  it('reads off out of a file this process never wrote', async () => {
    await writeFile(mcpPreferencePath(), '{"enabled": false}', 'utf8')
    expect(await readMcpEnabled()).toBe(false)
  })

  /**
   * Read by `whenReady` before the window is created, so a throw here would
   * be a config file costing the user their app. The two shapes a text file
   * can arrive in are covered: unparseable, and parseable with the field the
   * wrong type.
   */
  it.each([
    ['a file that does not parse', 'not json at all'],
    ['a top-level array', '[]'],
    ['an enabled that is not a boolean', '{"enabled": "false"}'],
    ['no enabled key at all', '{}'],
  ])('reads %s as on rather than throwing', async (_label, contents) => {
    await writeFile(mcpPreferencePath(), contents, 'utf8')
    expect(await readMcpEnabled()).toBe(true)
  })

  it('writes JSON a human can read and edit by hand', async () => {
    await writeMcpEnabled(false)
    expect(JSON.parse(await readFile(mcpPreferencePath(), 'utf8'))).toEqual({ enabled: false })
  })

  /**
   * Where it lives, and why it is a file rather than a field in
   * `config.json`: `PTERM_CONFIG_DIR` moves it with the socket and the bridge
   * script, so a test never reaches the real `~/.pterm`, and adding a key to
   * `PTermConfig` would have meant a version bump that costs an older build
   * every project and tab row in the file to carry one boolean.
   */
  it('lives beside the socket under PTERM_CONFIG_DIR', () => {
    expect(mcpPreferencePath()).toBe(join(dir, 'mcp.json'))
  })

  // Computed, never opened: this is the one test here that names the real
  // `~/.pterm`, and it must not so much as stat it.
  it('falls back to ~/.pterm when the variable is unset', () => {
    delete process.env.PTERM_CONFIG_DIR
    expect(mcpPreferencePath()).toBe(join(homedir(), '.pterm', 'mcp.json'))
  })
})
