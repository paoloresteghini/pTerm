import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderBridge } from '../../src/main/mcp/bridge'
import { formatResponseLine, parseRequestLine, type McpRequest } from '../../src/main/mcp/protocol'

/**
 * The bridge script, run the way Claude Code runs it: a separate process, on
 * a `node` binary this repo does not control, with only its environment to
 * tell it who it is and where the app is.
 *
 * Spawned rather than imported, and that is the point of putting this file
 * under `tests/integration`. The script is written to the user's disk as text
 * (`writeBridgeScript`) and must not import anything from `node_modules`, so
 * the only honest test of it is to run it. `process.execPath` here is node
 * itself, since vitest runs under node.
 *
 * The app end is a stub socket server speaking the line protocol from
 * `src/main/mcp/protocol.ts`, which is this repo's own code and is imported
 * rather than reimplemented: what is under test is the bridge's half of that
 * conversation, not the format.
 */
let dir: string
let scriptPath: string
let socketPath: string
let app: Server | null = null
let bridges: ChildProcessWithoutNullStreams[] = []

/** Every request the stub app received, in arrival order. */
let received: McpRequest[] = []
/** How many connections the stub app accepted, including ones sending nothing. */
let connections = 0

/**
 * A stub app on the unix socket, answering each request line with `reply`.
 *
 * Not started in `beforeEach`: half of these tests need the socket to be
 * absent, which is what "pTerm is not running" means.
 */
function startApp(reply: (request: McpRequest) => { ok: true; result: unknown } | { ok: false; error: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((connection: Socket) => {
      connections += 1
      connection.setEncoding('utf8')
      let buffer = ''
      connection.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          const request = parseRequestLine(line)
          if (!request) continue
          received.push(request)
          const answer = reply(request)
          connection.write(formatResponseLine({ id: request.id, ...answer }))
        }
      })
    })
    server.once('error', reject)
    server.listen(socketPath, () => {
      app = server
      resolve()
    })
  })
}

/** One running bridge, with a line-buffered view of its stdout. */
interface Bridge {
  send(message: unknown): void
  /** One line exactly as given, for input no client would ever produce. */
  sendRaw(line: string): void
  /** The next response line the bridge has written, waiting for it if needed. */
  next(): Promise<Record<string, unknown>>
  /** Everything on stderr so far. */
  stderr(): string
  end(): void
}

function startBridge(env: Record<string, string>): Bridge {
  const child = spawn(process.execPath, [scriptPath], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  bridges.push(child)

  const lines: Record<string, unknown>[] = []
  const waiting: ((line: Record<string, unknown>) => void)[] = []
  let buffer = ''
  let errors = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const text = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (text === '') continue
      const parsed = JSON.parse(text) as Record<string, unknown>
      const next = waiting.shift()
      if (next) next(parsed)
      else lines.push(parsed)
    }
  })
  child.stderr.on('data', (chunk: string) => {
    errors += chunk
  })

  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    sendRaw: (line) => child.stdin.write(`${line}\n`),
    next: () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const ready = lines.shift()
        if (ready) {
          resolve(ready)
          return
        }
        const timer = setTimeout(() => reject(new Error('the bridge wrote no response in 8s')), 8_000)
        waiting.push((line) => {
          clearTimeout(timer)
          resolve(line)
        })
      }),
    stderr: () => errors,
    end: () => child.stdin.end(),
  }
}

/** The text of a `tools/call` result, which is where an error is reported too. */
function callText(response: Record<string, unknown>): string {
  const result = response.result as { content?: { type: string; text: string }[] }
  return (result.content ?? []).map((entry) => entry.text).join('\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-bridge-'))
  scriptPath = join(dir, 'pterm-mcp')
  socketPath = join(dir, 'mcp.sock')
  await writeFile(scriptPath, renderBridge(), 'utf8')
  await chmod(scriptPath, 0o755)
  received = []
  connections = 0
})

afterEach(async () => {
  for (const child of bridges) child.kill()
  bridges = []
  await new Promise<void>((resolve) => {
    if (!app) {
      resolve()
      return
    }
    app.close(() => resolve())
  })
  app = null
  await rm(dir, { recursive: true, force: true })
})

describe('the MCP bridge script', () => {
  it('answers initialize with the protocol version the client asked for and a server name', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })

    const response = await bridge.next()
    expect(response.id).toBe(1)
    expect(response.jsonrpc).toBe('2.0')
    const result = response.result as Record<string, unknown>
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.capabilities).toEqual({ tools: {} })
    expect((result.serverInfo as { name: string }).name).toContain('pterm')
  })

  it('advertises exactly browser_navigate, with a url its schema requires', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    const tools = (await bridge.next()).result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }
    expect(tools.tools.map((tool) => tool.name)).toEqual(['browser_navigate'])
    expect(tools.tools[0]!.inputSchema).toMatchObject({
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' } },
    })
  })

  // The scope boundary this task turns on. A user-scoped registration is read
  // by every Claude session on the machine, including ones started in a plain
  // terminal, and those must not be offered control of anyone's browser.
  it('advertises no tools at all when it is not running inside a pTerm pane', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath })

    bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })

    expect((await bridge.next()).result).toEqual({ tools: [] })
  })

  it('refuses a call with no PTERM_TAB_ID, explains why, and never opens the socket', async () => {
    await startApp(() => ({ ok: true, result: 'should not be reached' }))
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath })

    bridge.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/' } },
    })

    const response = await bridge.next()
    expect((response.result as { isError: boolean }).isError).toBe(true)
    expect(callText(response)).toContain('PTERM_TAB_ID')
    // Not merely that the answer was an error: nothing was asked of the app.
    // A bridge that forwarded the call and let the app refuse it would look
    // identical from the outside, and would be a different design.
    expect(connections).toBe(0)
    expect(received).toEqual([])
  })

  it("forwards the call to the app as its pane's request and returns what the app answered", async () => {
    await startApp((request) => ({ ok: true, result: { paneId: 'browser-9', url: request.args.url } }))
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/' } },
    })

    const response = await bridge.next()
    expect(received).toEqual([
      { id: expect.any(Number), paneId: 'caller-1', tool: 'browser_navigate', args: { url: 'http://localhost:3000/' } },
    ])
    expect((response.result as { isError?: boolean }).isError).toBeUndefined()
    expect(callText(response)).toContain('browser-9')
  })

  it("reports the app's refusal as a tool error rather than swallowing it", async () => {
    await startApp(() => ({ ok: false, error: 'refusing to open https://example.com/' }))
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'https://example.com/' } },
    })

    const response = await bridge.next()
    expect((response.result as { isError: boolean }).isError).toBe(true)
    expect(callText(response)).toContain('refusing to open https://example.com/')
  })

  // No app is started in this test, so the socket file does not exist.
  it('fails with a message naming a pTerm that is not running, rather than hanging', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/' } },
    })

    const response = await bridge.next()
    expect((response.result as { isError: boolean }).isError).toBe(true)
    expect(callText(response)).toMatch(/not running/i)
  })

  it('answers an unknown method with method not found, and stays up', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({ jsonrpc: '2.0', id: 8, method: 'resources/list' })
    const refused = await bridge.next()
    expect((refused.error as { code: number }).code).toBe(-32601)

    bridge.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    expect((await bridge.next()).id).toBe(9)
  })

  // Measured against Claude Code 2.1.228 on 2026-08-12 by logging the wire:
  // its `initialize` carries `"id":0`. A bridge that told a notification apart
  // from a request by the truthiness of `id` would answer that with silence
  // and the client would hang on the handshake forever.
  it('answers a request whose id is 0, which is the one the real client sends first', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })

    expect((await bridge.next()).id).toBe(0)
  })

  it('answers a notification with nothing at all', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    // No id, so no response is owed. Sent ahead of a request that IS owed
    // one: if the notification were answered, that answer would arrive here
    // first and the id below would not match.
    bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    bridge.send({ jsonrpc: '2.0', id: 10, method: 'tools/list' })

    expect((await bridge.next()).id).toBe(10)
  })

  it('answers an unparseable line with a parse error and keeps reading', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })

    bridge.sendRaw('{ not json')
    const refused = await bridge.next()
    expect((refused.error as { code: number }).code).toBe(-32700)
    expect(refused.id).toBeNull()

    bridge.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' })
    expect((await bridge.next()).id).toBe(11)
  })

  it('exits when its stdin closes', async () => {
    const bridge = startBridge({ PTERM_MCP_SOCKET: socketPath, PTERM_TAB_ID: 'caller-1' })
    const child = bridges[bridges.length - 1]!

    bridge.end()

    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(code).toBe(0)
    expect(bridge.stderr()).toBe('')
  })
})
