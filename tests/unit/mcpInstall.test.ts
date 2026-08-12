import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MCP_SERVER_NAME,
  bridgeEntry,
  bridgePaths,
  installMcpBridge,
  isMcpInstalled,
  mcpConfigPath,
  mergeMcpServer,
  nodeBin,
  refreshMcpBridge,
  uninstallMcpBridge,
  unmergeMcpServer,
} from '../../src/main/mcp/install'

/**
 * Every one of these is set in `beforeEach`, and between them they are what
 * keeps this file off the developer's real machine state.
 *
 * `PTERM_MCP_CONFIG` is the important one. The file it redirects is
 * `~/.claude.json`, which on this machine is 191KB of a user's unrelated
 * state across 88 top-level keys and 49 project entries; a test that
 * read-modify-wrote the real one could destroy all of it. `PTERM_CONFIG_DIR`
 * keeps `bridgePaths()` out of the real `~/.pterm`, and `PTERM_NODE_BIN`
 * makes the registered command a fixed string rather than whatever node
 * happens to be installed on the machine running the suite.
 */
const saved = {
  config: process.env.PTERM_MCP_CONFIG,
  root: process.env.PTERM_CONFIG_DIR,
  node: process.env.PTERM_NODE_BIN,
}

const FAKE_NODE = '/fake/bin/node'

let dir: string
let configFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-install-'))
  configFile = join(dir, '.claude.json')
  process.env.PTERM_MCP_CONFIG = configFile
  process.env.PTERM_CONFIG_DIR = dir
  process.env.PTERM_NODE_BIN = FAKE_NODE
})

afterEach(async () => {
  for (const [key, value] of [
    ['PTERM_MCP_CONFIG', saved.config],
    ['PTERM_CONFIG_DIR', saved.root],
    ['PTERM_NODE_BIN', saved.node],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(dir, { recursive: true, force: true })
})

/**
 * Modelled on the real `~/.claude.json`, re-measured on 2026-08-12, not
 * invented. The four shapes taken from it are the ones a merge must not
 * disturb: many unrelated top-level keys, a large nested `projects` map, an
 * `mcpServers` map that already holds other servers, and those servers'
 * shapes. The real map holds four servers: two are `{ type: 'sse', url }`
 * (`obsidian`, `render`) and two are `{ type: 'stdio', command, args, env }`
 * (`mailgun`, `sendgrid`), the same fields this module writes. `obsidian`
 * below stands in for the sse pair and `mailgun` for the stdio pair, so this
 * fixture keeps a sibling shaped exactly like ours under a different key, not
 * only one shaped nothing like it.
 */
const MAILGUN_ENTRY = {
  type: 'stdio',
  command: '/usr/local/bin/mailgun-mcp',
  args: ['--config', '/etc/mailgun-mcp.json'],
  env: { MAILGUN_API_KEY: 'sk-not-real' },
}

function realistic(): Record<string, unknown> {
  return {
    numStartups: 487,
    installMethod: 'native',
    autoUpdates: false,
    userID: 'abc123',
    firstStartTime: '2025-11-02T09:14:00.000Z',
    tipsHistory: { 'new-user-warmup': 12, 'shift-enter': 3 },
    skillUsage: { 'superpowers:brainstorming': { count: 4 } },
    oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'someone@example.com' },
    projects: {
      '/Users/someone/Code/one': { allowedTools: [], history: [{ display: 'hi' }] },
      '/Users/someone/Code/two': { allowedTools: ['Bash'], mcpServers: {} },
    },
    mcpServers: {
      obsidian: { type: 'sse', url: 'http://localhost:22360/sse' },
      mailgun: MAILGUN_ENTRY,
    },
  }
}

function serversOf(config: Record<string, unknown>): Record<string, unknown> {
  return config.mcpServers as Record<string, unknown>
}

describe('mcpConfigPath', () => {
  it('honours PTERM_MCP_CONFIG as it stands when called', () => {
    expect(mcpConfigPath()).toBe(configFile)
  })

  it('falls back to ~/.claude.json, which is not the hooks settings file', () => {
    delete process.env.PTERM_MCP_CONFIG
    // Naming both halves on purpose. MCP servers live at the root of
    // ~/.claude.json; the hooks this app also installs live in a different
    // file, ~/.claude/settings.json, and confusing the two would have this
    // module writing its entry into a file that will never be read for it.
    expect(mcpConfigPath()).toBe(join(homedir(), '.claude.json'))
    expect(mcpConfigPath()).not.toBe(join(homedir(), '.claude', 'settings.json'))
  })
})

describe('bridgePaths', () => {
  it('puts the script and the socket under PTERM_CONFIG_DIR', () => {
    const paths = bridgePaths()
    expect(paths.dir).toBe(dir)
    expect(paths.script).toBe(join(dir, 'bin', 'pterm-mcp'))
    expect(paths.socket).toBe(join(dir, 'mcp.sock'))
  })
})

describe('nodeBin', () => {
  it('lets PTERM_NODE_BIN override everything', () => {
    expect(nodeBin({ PTERM_NODE_BIN: '/somewhere/node', PATH: '/usr/bin' })).toBe('/somewhere/node')
  })

  it('resolves an absolute path from PATH', async () => {
    // A real executable actually named `node`, so the resolution is exercised
    // rather than mocked, without depending on where the machine running the
    // suite happens to keep its own node.
    const binDir = join(dir, 'fake-bin')
    await mkdir(binDir)
    const fake = join(binDir, 'node')
    await writeFile(fake, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(fake, 0o755)

    expect(nodeBin({ PATH: binDir }, [])).toBe(fake)
  })

  it('prefers PATH over the fallback directories', async () => {
    // Both directories must really hold an executable `node`, or this proves
    // nothing: passing real system directories as the fallback would leave the
    // test passing whether or not PATH won, because no node lives in /usr/bin
    // or /bin on the machine this was written on.
    const chosen = join(dir, 'chosen-bin')
    const fallback = join(dir, 'fallback-bin')
    for (const binDir of [chosen, fallback]) {
      await mkdir(binDir)
      const fake = join(binDir, 'node')
      await writeFile(fake, '#!/bin/sh\nexit 0\n', 'utf8')
      await chmod(fake, 0o755)
    }

    // A deliberately chosen install must beat the directories the fallback
    // list only exists to cover, the same rule resolveBin documents.
    expect(nodeBin({ PATH: chosen }, [fallback])).toBe(join(chosen, 'node'))
    // And the fallback must still be reached when PATH has nothing.
    expect(nodeBin({ PATH: '/nonexistent' }, [fallback])).toBe(join(fallback, 'node'))
  })

  it('returns the bare name when nothing is found, so the spawn fails visibly', () => {
    // The opposite of the failure this replaced: a disabled RunAsNode fuse
    // made the packaged binary exit 0 with no output, which a caller cannot
    // tell from a server that started and said nothing. An ENOENT can be seen.
    expect(nodeBin({ PATH: '/nonexistent' }, [])).toBe('node')
  })
})

describe('bridgeEntry', () => {
  it('registers a resolved node, the bridge script and the socket', () => {
    expect(bridgeEntry()).toEqual({
      type: 'stdio',
      command: FAKE_NODE,
      args: [join(dir, 'bin', 'pterm-mcp')],
      env: { PTERM_MCP_SOCKET: join(dir, 'mcp.sock') },
    })
  })

  it('sets no ELECTRON_RUN_AS_NODE, which this app\'s packaged binary ignores', () => {
    // Measured 2026-08-12: forge.config.ts sets RunAsNode: false, and the
    // packaged binary therefore ignores the variable and launches the app.
    // Carrying it would be a claim about this app that is not true of it.
    expect(bridgeEntry().env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('does not register the running Electron binary as the runtime', () => {
    expect(bridgeEntry().command).not.toBe(process.execPath)
  })
})

describe('mergeMcpServer', () => {
  it('keeps every unrelated top-level key', () => {
    // The single most important property in this file. ~/.claude.json is 191KB
    // of state belonging to the user and to Claude Code, and this module has
    // no business in any of it beyond one key inside mcpServers.
    const before = realistic()
    const { next } = mergeMcpServer(before, bridgeEntry())

    for (const key of Object.keys(before)) {
      if (key === 'mcpServers') continue
      expect(next[key]).toEqual(before[key])
    }
    expect(Object.keys(next).sort()).toEqual(Object.keys(before).sort())
  })

  it('keeps every other server, including one shaped exactly like ours', () => {
    // mailgun has the same fields as our own entry (type/command/args/env)
    // under a different key. If a merge ever matched an existing entry by
    // shape instead of by MCP_SERVER_NAME, this is the case that would catch
    // it: mailgun would be overwritten or merged into instead of left alone.
    const before = realistic()
    const { next } = mergeMcpServer(before, bridgeEntry())
    const servers = serversOf(next)

    expect(servers.obsidian).toEqual({ type: 'sse', url: 'http://localhost:22360/sse' })
    expect(servers.mailgun).toEqual(MAILGUN_ENTRY)
    expect(Object.keys(servers).sort()).toEqual(['mailgun', MCP_SERVER_NAME, 'obsidian'].sort())
  })

  it('adds our entry under our own name', () => {
    const { next, changed } = mergeMcpServer(realistic(), bridgeEntry())
    expect(changed).toBe(true)
    expect(serversOf(next)[MCP_SERVER_NAME]).toEqual(bridgeEntry())
  })

  it('is idempotent, so a second merge changes nothing', () => {
    const once = mergeMcpServer(realistic(), bridgeEntry())
    const twice = mergeMcpServer(once.next, bridgeEntry())
    expect(twice.changed).toBe(false)
    expect(twice.next).toEqual(once.next)
  })

  it('rewrites our entry when the resolved runtime has moved', () => {
    // The self-heal: a dev tree reinstalled or an app bundle moved leaves a
    // command that no longer exists, and nobody will notice by hand.
    const stale = mergeMcpServer(realistic(), bridgeEntry()).next
    process.env.PTERM_NODE_BIN = '/somewhere/else/node'

    const { next, changed } = mergeMcpServer(stale, bridgeEntry())
    expect(changed).toBe(true)
    expect((serversOf(next)[MCP_SERVER_NAME] as { command: string }).command).toBe(
      '/somewhere/else/node',
    )
    // Still only our key moved.
    expect(serversOf(next).obsidian).toEqual({ type: 'sse', url: 'http://localhost:22360/sse' })
  })

  it('builds an mcpServers map from nothing when the file has none', () => {
    const { next, changed } = mergeMcpServer({ numStartups: 3 }, bridgeEntry())
    expect(changed).toBe(true)
    expect(next.numStartups).toBe(3)
    expect(Object.keys(serversOf(next))).toEqual([MCP_SERVER_NAME])
  })

  it('treats a config that is not an object as an empty one', () => {
    for (const value of [null, 'nonsense', [], 42]) {
      expect(mergeMcpServer(value, bridgeEntry()).changed).toBe(true)
    }
  })

  it('carries through a server value it does not understand', () => {
    // Not ours to repair, and not ours to drop either.
    const config = { mcpServers: { weird: 'a string', alsoWeird: null } }
    const { next } = mergeMcpServer(config, bridgeEntry())
    expect(serversOf(next).weird).toBe('a string')
    expect(serversOf(next).alsoWeird).toBeNull()
  })

  it('does not mutate the config it was given', () => {
    const before = realistic()
    const snapshot = JSON.parse(JSON.stringify(before))
    mergeMcpServer(before, bridgeEntry())
    expect(before).toEqual(snapshot)
  })

  it('refuses an mcpServers that is not an object rather than overwriting it', () => {
    for (const value of ['a string', 42, ['a', 'list'], true]) {
      expect(() => mergeMcpServer({ mcpServers: value }, bridgeEntry())).toThrow(/mcpServers/)
    }
  })

  it('treats a null mcpServers as absent rather than refusing', () => {
    // JSON null is how a key gets emptied, not a shape that needs a human.
    const { next, changed } = mergeMcpServer({ mcpServers: null }, bridgeEntry())
    expect(changed).toBe(true)
    expect(Object.keys(serversOf(next))).toEqual([MCP_SERVER_NAME])
  })
})

describe('isMcpInstalled', () => {
  it('is false before and true after', () => {
    expect(isMcpInstalled(realistic())).toBe(false)
    expect(isMcpInstalled(mergeMcpServer(realistic(), bridgeEntry()).next)).toBe(true)
  })

  it('does not mistake another tool\'s server for ours, whatever its shape', () => {
    expect(isMcpInstalled({ mcpServers: { obsidian: { type: 'sse', url: 'x' } } })).toBe(false)
    // mailgun here is shaped exactly like our own entry, just under a
    // different key. It must not read as installed either.
    expect(isMcpInstalled({ mcpServers: { mailgun: MAILGUN_ENTRY } })).toBe(false)
  })

  it('is total, so a shape merge would refuse answers false rather than throwing', () => {
    // The pane that renders install state must be able to ask this question of
    // any file at all; refusing is install's job, not the read's.
    expect(() => isMcpInstalled({ mcpServers: 'a string' })).not.toThrow()
    expect(isMcpInstalled({ mcpServers: 'a string' })).toBe(false)
    expect(isMcpInstalled(null)).toBe(false)
  })
})

describe('unmergeMcpServer', () => {
  it('removes ours and leaves every other server and key', () => {
    const before = realistic()
    const installed = mergeMcpServer(before, bridgeEntry()).next
    const { next, removed } = unmergeMcpServer(installed)

    expect(removed).toBe(true)
    expect(next).toEqual(before)
  })

  it('drops the mcpServers key when ours was the only server in it', () => {
    const installed = mergeMcpServer({ numStartups: 3 }, bridgeEntry()).next
    const { next } = unmergeMcpServer(installed)
    // Leaving `"mcpServers": {}` behind is litter in a file the user reads.
    expect(next).toEqual({ numStartups: 3 })
    expect('mcpServers' in next).toBe(false)
  })

  it('does not invent an mcpServers key for a file that had none', () => {
    const { next, removed } = unmergeMcpServer({ numStartups: 3 })
    expect(removed).toBe(false)
    expect(next).toEqual({ numStartups: 3 })
  })

  it('removes nothing when ours is not there', () => {
    const before = realistic()
    const { next, removed } = unmergeMcpServer(before)
    expect(removed).toBe(false)
    expect(next).toEqual(before)
  })

  it('leaves a shape it does not recognise exactly as it found it', () => {
    const before = { mcpServers: 'a string' }
    const { next, removed } = unmergeMcpServer(before)
    expect(removed).toBe(false)
    expect(next).toEqual(before)
  })

  it('does not mutate the config it was given', () => {
    const installed = mergeMcpServer(realistic(), bridgeEntry()).next
    const snapshot = JSON.parse(JSON.stringify(installed))
    unmergeMcpServer(installed)
    expect(installed).toEqual(snapshot)
  })
})

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(configFile, JSON.stringify(value, null, 2), 'utf8')
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configFile, 'utf8'))
}

async function backups(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.bak'))
}

describe('installMcpBridge', () => {
  it('creates a fresh config when there is no file at all', async () => {
    const { changed, configPath } = await installMcpBridge()
    expect(changed).toBe(true)
    expect(configPath).toBe(configFile)
    expect(serversOf(await readConfig())[MCP_SERVER_NAME]).toEqual(bridgeEntry())
  })

  it('keeps every unrelated key across a real read-modify-write', async () => {
    // The same property as the pure test above, asserted through the file, so
    // that a merge that is right and a write that is wrong cannot both pass.
    const before = realistic()
    await writeConfig(before)

    await installMcpBridge()

    const after = await readConfig()
    for (const key of Object.keys(before)) {
      if (key === 'mcpServers') continue
      expect(after[key]).toEqual(before[key])
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expect(serversOf(after).obsidian).toEqual({ type: 'sse', url: 'http://localhost:22360/sse' })
  })

  it('backs the file up before overwriting it', async () => {
    await writeConfig(realistic())
    expect(await backups()).toHaveLength(0)

    await installMcpBridge()

    const saved = await backups()
    expect(saved).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, saved[0]), 'utf8'))).toEqual(realistic())
  })

  it('writes nothing at all on a second install', async () => {
    await writeConfig(realistic())
    await installMcpBridge()
    const first = await stat(configFile)

    const { changed } = await installMcpBridge()

    expect(changed).toBe(false)
    expect((await stat(configFile)).mtimeMs).toBe(first.mtimeMs)
    // A no-op install must not leave a second backup behind either.
    expect(await backups()).toHaveLength(1)
  })

  it('refuses an unrecognised mcpServers without touching the file', async () => {
    const before = '{\n  "mcpServers": "a string"\n}'
    await writeFile(configFile, before, 'utf8')

    await expect(installMcpBridge()).rejects.toThrow(/mcpServers/)

    expect(await readFile(configFile, 'utf8')).toBe(before)
    expect(await backups()).toHaveLength(0)
  })

  it('refuses a file that does not parse rather than replacing it', async () => {
    // A config we cannot read is a config we must not overwrite: the ENOENT
    // path exists because nothing was there to lose, and this is not that.
    await writeFile(configFile, '{ not json', 'utf8')

    await expect(installMcpBridge()).rejects.toThrow()

    expect(await readFile(configFile, 'utf8')).toBe('{ not json')
    expect(await backups()).toHaveLength(0)
  })

  it('refuses a file that parses to something other than an object', async () => {
    // Stricter than the hooks installer, whose asSettings would treat this as
    // an empty object and write over it. A file we plainly did not understand
    // is not one to replace.
    await writeFile(configFile, '["not", "a", "config"]', 'utf8')

    await expect(installMcpBridge()).rejects.toThrow()

    expect(await readFile(configFile, 'utf8')).toBe('["not", "a", "config"]')
    expect(await backups()).toHaveLength(0)
  })

  it('writes the file the way Claude Code does', async () => {
    // Measured 2026-08-12: the real file is 2-space pretty-printed and ends
    // with `}` and no trailing newline. Matching it keeps this app's write
    // from showing up as a whole-file reformat.
    await writeConfig(realistic())
    await installMcpBridge()

    const raw = await readFile(configFile, 'utf8')
    expect(raw.startsWith('{\n  "numStartups": 487,')).toBe(true)
    expect(raw.endsWith('}')).toBe(true)
  })
})

describe('uninstallMcpBridge', () => {
  it('removes ours, keeps everything else, and backs up first', async () => {
    const before = realistic()
    await writeConfig(before)
    await installMcpBridge()

    const { removed } = await uninstallMcpBridge()

    expect(removed).toBe(true)
    expect(await readConfig()).toEqual(before)

    // Asserted by content rather than by counting to two. The backup name is
    // stamped with Date.now(), so an install and an uninstall landing in the
    // same millisecond write the same filename and there is one file, not two.
    // What must be true either way is that the state uninstall was about to
    // destroy was saved first.
    const saved = await backups()
    expect(saved.length).toBeGreaterThanOrEqual(1)
    const contents = await Promise.all(
      saved.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))),
    )
    expect(contents.some((value) => isMcpInstalled(value))).toBe(true)
  })

  it('writes nothing when ours was never there', async () => {
    await writeConfig(realistic())
    const first = await stat(configFile)

    const { removed } = await uninstallMcpBridge()

    expect(removed).toBe(false)
    expect((await stat(configFile)).mtimeMs).toBe(first.mtimeMs)
    expect(await backups()).toHaveLength(0)
  })
})

describe('refreshMcpBridge', () => {
  it('installs nothing into a config that never asked for it', async () => {
    // The consent rule, and the reason this is not just installMcpBridge() on
    // a timer: this runs unattended at startup, and a user who has never
    // pressed Install must not find an MCP server registered for them.
    await writeConfig(realistic())
    const first = await stat(configFile)

    const { changed } = await refreshMcpBridge()

    expect(changed).toBe(false)
    expect(isMcpInstalled(await readConfig())).toBe(false)
    expect((await stat(configFile)).mtimeMs).toBe(first.mtimeMs)
  })

  it('does nothing when there is no config file at all', async () => {
    const { changed } = await refreshMcpBridge()
    expect(changed).toBe(false)
    await expect(readFile(configFile, 'utf8')).rejects.toThrow()
  })

  it('re-points an existing install at a runtime that has moved', async () => {
    await writeConfig(realistic())
    await installMcpBridge()
    process.env.PTERM_NODE_BIN = '/somewhere/else/node'

    const { changed } = await refreshMcpBridge()

    expect(changed).toBe(true)
    const entry = serversOf(await readConfig())[MCP_SERVER_NAME] as { command: string }
    expect(entry.command).toBe('/somewhere/else/node')
  })

  it('writes nothing when the resolved runtime has not moved', async () => {
    await writeConfig(realistic())
    await installMcpBridge()
    const first = await stat(configFile)

    const { changed } = await refreshMcpBridge()

    expect(changed).toBe(false)
    expect((await stat(configFile)).mtimeMs).toBe(first.mtimeMs)
  })

  it('leaves an unrecognised mcpServers alone even when the runtime has moved', async () => {
    // The refusal has to win over the self-heal: this is the one path that can
    // write the user's config without anyone asking. It wins structurally
    // rather than by ordering. Our entry can only live inside an mcpServers
    // that is an object, so a config carrying anything else there is never
    // installed, and the consent check returns before the merge that would
    // have to refuse it. Silence rather than a throw is deliberate here, since
    // this runs unattended at launch; the attended path throws, one describe up.
    const before = '{\n  "mcpServers": "a string"\n}'
    await writeFile(configFile, before, 'utf8')
    process.env.PTERM_NODE_BIN = '/somewhere/else/node'

    const { changed } = await refreshMcpBridge()

    expect(changed).toBe(false)
    expect(await readFile(configFile, 'utf8')).toBe(before)
    expect(await backups()).toHaveLength(0)
  })
})
