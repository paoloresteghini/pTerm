import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { connect } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderBridge } from '../../src/main/mcp/bridge'
import { mcpBridgeState, setMcpEnabled, readMcpEnabled } from '../../src/main/mcp/enabled'
import { bridgePaths, isMcpInstalled } from '../../src/main/mcp/install'
import { McpServer } from '../../src/main/mcp/server'

/**
 * The off switch against a real socket.
 *
 * The point of this file is the ruling it exists to check: off means the
 * server is not accepting, not merely that the entry is gone from
 * `~/.claude.json`. The principal the browser tool is scoped against is an
 * agent with a shell, which can write that entry back itself, so every
 * assertion below about the config is paired with one about the socket.
 *
 * `PTERM_CONFIG_DIR` moves the socket, the bridge script and the preference
 * file into a temp directory; `PTERM_MCP_CONFIG` moves the Claude config that
 * `setMcpEnabled` registers into and out of. Between them nothing here can
 * reach the developer's real `~/.pterm` or `~/.claude.json`. `PTERM_NODE_BIN`
 * makes the registered command a fixed string rather than whatever node the
 * machine running the suite happens to have.
 */
const saved = {
  root: process.env.PTERM_CONFIG_DIR,
  config: process.env.PTERM_MCP_CONFIG,
  node: process.env.PTERM_NODE_BIN,
}

let dir: string
let configFile: string
let server: McpServer | null = null

/**
 * Whether anything is accepting on `path` right now.
 *
 * Deliberately a second copy of `probeListening` rather than an import: that
 * one is private to the module under test, and a check that shares its code
 * with the thing it is checking cannot fail when that code is wrong.
 */
function accepting(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** One request in, one response line out, or null when the socket refused. */
function ask(path: string, line: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(path)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.destroy()
      resolve(buffer.slice(0, newline))
    })
    socket.on('error', () => resolve(null))
    socket.on('close', () => resolve(null))
    socket.on('connect', () => socket.write(line))
  })
}

const REQUEST = '{"id":1,"paneId":"p","tool":"browser_navigate","args":{}}\n'

async function claudeConfig(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(configFile, 'utf8'))
  } catch {
    return {}
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-switch-'))
  configFile = join(dir, '.claude.json')
  process.env.PTERM_CONFIG_DIR = dir
  process.env.PTERM_MCP_CONFIG = configFile
  process.env.PTERM_NODE_BIN = '/fake/bin/node'
  server = new McpServer(async (request) => ({ echoed: request.tool }))
})

afterEach(async () => {
  await server?.close()
  server = null
  for (const [key, value] of [
    ['PTERM_CONFIG_DIR', saved.root],
    ['PTERM_MCP_CONFIG', saved.config],
    ['PTERM_NODE_BIN', saved.node],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(dir, { recursive: true, force: true })
})

describe('setMcpEnabled', () => {
  /**
   * The whole ruling in one test, with the control first: the socket really
   * is serving before the switch is thrown, so the refusal afterwards is the
   * switch and not a socket that never worked.
   */
  it('stops the socket accepting, not just the registration', async () => {
    const socket = bridgePaths().socket
    const on = await setMcpEnabled(true, server!)
    expect(on).toEqual({ enabled: true, error: null })
    expect(await ask(socket, REQUEST)).toContain('"ok":true')
    expect(isMcpInstalled(await claudeConfig())).toBe(true)

    const off = await setMcpEnabled(false, server!)

    expect(off).toEqual({ enabled: false, error: null })
    expect(await accepting(socket)).toBe(false)
    expect(await ask(socket, REQUEST)).toBeNull()
    expect(isMcpInstalled(await claudeConfig())).toBe(false)
  })

  /**
   * A call already on the socket when the switch is thrown.
   *
   * The handler here never settles, which is the shape that hangs: `net`'s
   * own `server.close()` waits for every live connection to end, so without
   * `McpServer.close` destroying them this `await` never returns and the
   * user's click never comes back. Reaching the assertions at all is the
   * assertion, and a regression here fails as this file's 15s timeout.
   *
   * What the caller on the other end sees is a close with no response, which
   * the bridge script turns into a sentence for the model rather than a wait
   * that runs to its own 30s timeout. That sentence is pinned below rather
   * than described, because it is the difference between failing clearly and
   * hanging, and it lives in a different file.
   */
  it('answers an in-flight call instead of hanging when it is turned off', async () => {
    const socket = bridgePaths().socket
    let entered = false
    server = new McpServer(async () => {
      entered = true
      return new Promise(() => undefined)
    })
    await setMcpEnabled(true, server)

    let response: string | null = 'not settled'
    const inFlight = ask(socket, REQUEST).then((line) => {
      response = line
    })
    await expect.poll(() => entered).toBe(true)

    await setMcpEnabled(false, server)

    await inFlight
    expect(response).toBeNull()
    expect(renderBridge()).toContain('pTerm closed the connection without answering')
  })

  /** Back on without a relaunch: the socket rebinds and the entry returns. */
  it('rebinds the socket and re-registers when it is turned back on', async () => {
    const socket = bridgePaths().socket
    await setMcpEnabled(true, server!)
    await setMcpEnabled(false, server!)
    expect(await accepting(socket)).toBe(false)

    const on = await setMcpEnabled(true, server!)

    expect(on).toEqual({ enabled: true, error: null })
    expect(await ask(socket, REQUEST)).toContain('"ok":true')
    expect(isMcpInstalled(await claudeConfig())).toBe(true)
    // The script the registration names, written by turning it on rather than
    // only by a launch: a config that points at a file that is not there is a
    // tool that fails at spawn time.
    expect(await readFile(bridgePaths().script, 'utf8')).toBe(renderBridge())
  })

  /**
   * The reason the preference is persisted rather than inferred from the
   * absence of the entry: those two states are different, and only one of
   * them means the user said no. Here nothing was ever registered, so the
   * config looks identical before and after, and the file is the only record
   * that a decision was taken at all.
   */
  it('records off even when nothing was ever registered', async () => {
    await writeFile(configFile, JSON.stringify({ projects: {} }), 'utf8')
    expect(isMcpInstalled(await claudeConfig())).toBe(false)

    const off = await setMcpEnabled(false, server!)

    expect(off.enabled).toBe(false)
    expect(isMcpInstalled(await claudeConfig())).toBe(false)
    // The half the config cannot tell you, and the half a relaunch reads.
    expect(await readMcpEnabled()).toBe(false)
  })

  /**
   * A `~/.claude.json` that cannot be read, which both installers throw on.
   *
   * The launch path already keeps that off the window-opening path; this
   * keeps it off the switch. Turning off must still deny (that is the half
   * that matters, and it does not depend on that file at all), and the user
   * must be told what could not be done rather than shown a button that threw.
   */
  it('still stops serving when the Claude config cannot be read, and says why', async () => {
    await setMcpEnabled(true, server!)
    const socket = bridgePaths().socket
    await writeFile(configFile, '{ this is not JSON', 'utf8')

    const off = await setMcpEnabled(false, server!)

    expect(off.enabled).toBe(false)
    expect(off.error).toContain('.claude.json')
    expect(await accepting(socket)).toBe(false)
  })

  it('still starts serving when the Claude config cannot be read, and says why', async () => {
    await writeFile(configFile, '{ this is not JSON', 'utf8')

    const on = await setMcpEnabled(true, server!)

    expect(on.enabled).toBe(true)
    expect(on.error).toContain('.claude.json')
    expect(await ask(bridgePaths().socket, REQUEST)).toContain('"ok":true')
  })
})

/**
 * What the settings section is told on mount, which is the one place this
 * screen could say something the socket disagrees with.
 *
 * `listen` at `src/main/index.ts` can throw with the switch on (a socket a
 * live process holds, a path over the macOS limit) and the launch carries on
 * with only a stderr line. Without the probe, Settings then reads `on` over a
 * bridge that is not serving. The `close()` below stands in for that launch:
 * the preference still says on, and nothing is listening.
 */
describe('mcpBridgeState', () => {
  it('says on with nothing to report while the socket is accepting', async () => {
    await setMcpEnabled(true, server!)

    expect(await mcpBridgeState()).toEqual({ enabled: true, error: null })
  })

  it('says on with a note when the setting is on and nothing is listening', async () => {
    await setMcpEnabled(true, server!)
    // Not through `setMcpEnabled`, deliberately: this is a bridge that is
    // switched on and not serving, which is what a failed `listen` leaves.
    await server!.close()
    expect(await readMcpEnabled()).toBe(true)

    const state = await mcpBridgeState()

    expect(state.enabled).toBe(true)
    expect(state.error).toContain('not listening')
    expect(state.error).toContain(bridgePaths().socket)
  })

  /**
   * The control that keeps the note from being an alarm on every correct
   * install: nothing is listening here either, and that is what off means.
   */
  it('says off with nothing to report, without probing a socket it wants closed', async () => {
    await setMcpEnabled(false, server!)
    expect(await accepting(bridgePaths().socket)).toBe(false)

    expect(await mcpBridgeState()).toEqual({ enabled: false, error: null })
  })
})
