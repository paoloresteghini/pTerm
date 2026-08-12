import { describe, it, expect, afterEach } from 'vitest'
import { connect, createServer } from 'node:net'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '../../src/main/mcp/server'
import type { McpRequest, McpResponse } from '../../src/main/mcp/protocol'

let dir: string
let server: McpServer | null = null

/**
 * `dir` under a byte-exact target so the macOS `sun_path` boundary can be
 * tested precisely rather than just "obviously too long". Every character
 * used is ASCII, so string length and byte length coincide.
 */
function socketOfLength(base: string, targetBytes: number): string {
  const fixed = Buffer.byteLength(base, 'utf8') + 1 // separator before the filler
  const fillerLength = targetBytes - fixed
  if (fillerLength < 1) throw new Error('base path already exceeds target length')
  return join(base, 'a'.repeat(fillerLength))
}

/** A raw net.connect client that collects parsed response lines. */
function client(socket: string): {
  send: (line: string) => void
  responses: McpResponse[]
  close: () => void
  waitFor: (count: number) => Promise<void>
} {
  const responses: McpResponse[] = []
  let buffer = ''
  const sock = connect(socket)
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) responses.push(JSON.parse(line) as McpResponse)
      newline = buffer.indexOf('\n')
    }
  })
  return {
    send: (line: string) => {
      sock.write(line)
    },
    responses,
    close: () => sock.destroy(),
    waitFor: (count: number) => expect.poll(() => responses.length).toBe(count),
  }
}

async function start(handler: (request: McpRequest) => Promise<unknown>): Promise<{ server: McpServer; socket: string }> {
  dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-'))
  const socket = join(dir, 'mcp.sock')
  server = new McpServer(handler)
  await server.listen(socket)
  return { server, socket }
}

afterEach(async () => {
  await server?.close()
  server = null
  await rm(dir, { recursive: true, force: true })
})

describe('McpServer', () => {
  it('returns a response with the same id as the request', async () => {
    const { socket } = await start(async (request) => ({ echoed: request.tool }))
    const c = client(socket)

    c.send(`{"id":1,"paneId":"p","tool":"browser_navigate","args":{}}\n`)

    await c.waitFor(1)
    expect(c.responses[0]).toEqual({ id: 1, ok: true, result: { echoed: 'browser_navigate' } })
    c.close()
  })

  it('answers two requests on one connection with two responses, in submission order, even when the first resolves after the second would have', async () => {
    // id 1 is deliberately the slow one: its handler does not settle until
    // well after id 2's would have. Two requests that both resolve in the
    // same microtask tick cannot tell a real serialization queue apart from
    // independent per-request dispatch, since microtasks drain in submission
    // order either way. A 50ms delay on id 1 against an effectively
    // immediate id 2 is not a close call on any machine: the gap is four to
    // five orders of magnitude past microtask or scheduler jitter, so this
    // is not a timing-flaky assertion.
    const { socket } = await start(async (request) => {
      if (request.id === 1) await new Promise((resolve) => setTimeout(resolve, 50))
      return { id: request.id }
    })
    const c = client(socket)

    c.send(`{"id":1,"paneId":"p","tool":"a","args":{}}\n`)
    c.send(`{"id":2,"paneId":"p","tool":"b","args":{}}\n`)

    await c.waitFor(2)
    expect(c.responses.map((r) => r.id)).toEqual([1, 2])
    expect(c.responses.every((r) => r.ok)).toBe(true)
    c.close()
  })

  it('turns a rejected handler into ok:false with the message, without killing the connection', async () => {
    const { socket } = await start(async () => {
      throw new Error('pane not found')
    })
    const c = client(socket)

    c.send(`{"id":1,"paneId":"p","tool":"a","args":{}}\n`)
    await c.waitFor(1)
    expect(c.responses[0]).toEqual({ id: 1, ok: false, error: 'pane not found' })

    // Connection must still be alive: a second request gets a second response.
    c.send(`{"id":2,"paneId":"p","tool":"a","args":{}}\n`)
    await c.waitFor(2)
    expect(c.responses[1]).toEqual({ id: 2, ok: false, error: 'pane not found' })
    c.close()
  })

  it('answers a malformed line with an error response when its id can be recovered', async () => {
    const { socket } = await start(async () => ({}))
    const c = client(socket)

    // Valid JSON object, valid id, but paneId is the wrong type.
    c.send(`{"id":7,"paneId":123,"tool":"a"}\n`)

    await c.waitFor(1)
    expect(c.responses[0]?.id).toBe(7)
    expect(c.responses[0]?.ok).toBe(false)
    c.close()
  })

  it('drops a malformed line silently when no id can be recovered, and keeps serving the connection', async () => {
    const { socket } = await start(async (request) => ({ id: request.id }))
    const c = client(socket)

    c.send('not json at all\n')
    c.send('{"paneId":"p","tool":"a"}\n') // valid JSON, no id field
    c.send(`{"id":9,"paneId":"p","tool":"a","args":{}}\n`)

    await c.waitFor(1)
    // Only the well-formed request produced a response.
    expect(c.responses).toEqual([{ id: 9, ok: true, result: { id: 9 } }])
    c.close()
  })

  it('says plainly when the socket path is too long, rather than a bare EINVAL', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-'))
    const deep = join(dir, 'a'.repeat(60), 'b'.repeat(60))
    await mkdir(deep, { recursive: true })
    const socket = join(deep, 'mcp.sock')

    server = new McpServer(async () => ({}))
    await expect(server.listen(socket)).rejects.toThrow(/too long/i)
    server = null
  })

  it('accepts a path at exactly the measured macOS ceiling (104 bytes)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-'))
    const socket = socketOfLength(dir, 104)
    expect(Buffer.byteLength(socket, 'utf8')).toBe(104)

    server = new McpServer(async () => ({}))
    await expect(server.listen(socket)).resolves.toBeUndefined()
  })

  it('rejects a path one byte past the measured macOS ceiling (105 bytes)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-'))
    const socket = socketOfLength(dir, 105)
    expect(Buffer.byteLength(socket, 'utf8')).toBe(105)

    server = new McpServer(async () => ({}))
    await expect(server.listen(socket)).rejects.toThrow(/too long/i)
    server = null
  })

  it('replaces a stale socket file left by a crash', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-'))
    const socket = join(dir, 'mcp.sock')
    await writeFile(socket, 'stale', 'utf8')

    server = new McpServer(async () => ({}))
    await expect(server.listen(socket)).resolves.toBeUndefined()
  })

  it('does not steal a socket a live process is actually using', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pterm-mcp-'))
    const socket = join(dir, 'mcp.sock')

    const owner = createServer((c) => c.destroy())
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject)
      owner.listen(socket, () => {
        owner.removeAllListeners('error')
        resolve()
      })
    })

    try {
      server = new McpServer(async () => ({}))
      await expect(server.listen(socket)).rejects.toThrow(/already in use/i)
      server = null
    } finally {
      await new Promise<void>((resolve) => owner.close(() => resolve()))
    }
  })

  it('drops a runaway line with no newline instead of buffering it without limit', async () => {
    const { socket } = await start(async (request) => ({ id: request.id }))
    const c = client(socket)

    // Far larger than MAX_LINE_BYTES, no newline: the shape that would grow
    // the buffer forever if nothing bounded it.
    c.send('y'.repeat(2_000_000))
    c.send(`\n{"id":3,"paneId":"p","tool":"a","args":{}}\n`)

    await c.waitFor(1)
    expect(c.responses).toEqual([{ id: 3, ok: true, result: { id: 3 } }])
    c.close()
  })
})
