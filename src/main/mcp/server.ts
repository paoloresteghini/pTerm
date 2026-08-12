import { connect, createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { MAX_LINE_BYTES, parseRequestLine, formatResponseLine, type McpRequest, type McpResponse } from './protocol'

/**
 * macOS caps a unix socket path (`sun_path`) near 104 bytes. Past it, `bind`
 * fails with a bare `EINVAL` that says nothing about the length. Carried over
 * from `src/main/hooks/server.ts`, where 104 (not 103) was measured directly
 * against this machine's kernel (Darwin, Node v25): `net.Server#listen` on a
 * path of exactly 104 bytes succeeds; 105 fails `EINVAL`. That is a property
 * of the kernel, not of the hook protocol, so it applies unchanged here.
 */
const MAX_SOCKET_PATH_BYTES = 104

/**
 * Enough for a great many well-formed lines, and a hard ceiling on what one
 * connection can make the process hold. A client that sends no newline at all
 * is the shape that would otherwise grow a buffer forever.
 *
 * Carried over from `src/main/hooks/server.ts`, recomputed against this
 * protocol's own `MAX_LINE_BYTES` (8192, not the hooks' 512): the 128x margin
 * still holds, so a legitimate line can never itself be long enough to
 * trigger the clear below.
 */
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 128

/**
 * One `data` event's worth of framing: the complete lines it finished, and
 * what is left held for the next one.
 *
 * Pure, and exported, because the ceiling above is otherwise invisible to a
 * test. Over a real socket a runaway is indistinguishable from a bounded one:
 * the newline that eventually arrives hands `take` a line that
 * `parseRequestLine` and `recoverId` both refuse on `MAX_LINE_BYTES` whether
 * or not anything dropped the buffer first, so the next request is answered
 * identically either way and the only thing that differed was peak heap.
 * Measured 2026-08-12: the integration test that used to make this claim
 * passed byte-identically with the clear below deleted. Here the held string
 * is the return value, so the bound is an assertion rather than an inference.
 *
 * The clear is deliberately all-or-nothing rather than a trim to the last
 * `MAX_BUFFER_BYTES`: a buffer this size holds no line this protocol can
 * accept, so there is nothing in it worth keeping, and 128 times
 * `MAX_LINE_BYTES` of margin means a legitimate line can never reach it.
 */
export function takeLines(held: string, chunk: string): { lines: string[]; held: string } {
  let buffer = held + chunk
  const lines: string[] = []
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    lines.push(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
  }
  // No newline in sight and already past the ceiling: this is not a line that
  // is going to arrive. Drop what is held rather than keep growing.
  if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) buffer = ''
  return { lines, held: buffer }
}

/**
 * Whether a live process is actually accepting connections on `path`.
 *
 * Carried over from `src/main/hooks/server.ts`: a unix socket file can exist
 * with nothing behind it, exactly what a crashed process leaves, and what
 * makes `listen` fail `EADDRINUSE` on the next launch. Connecting is the only
 * way to tell that apart from a second live process genuinely holding the
 * socket open.
 */
function probeListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/**
 * Recovers the `id` from a line `parseRequestLine` refused, so a malformed
 * request can still get an `ok: false` response instead of leaving the
 * bridge waiting on an id it will never hear back from.
 *
 * Deliberately narrower than `parseRequestLine`: it only needs enough of the
 * request to be trustworthy to echo an id back, not a whole valid request.
 * Returns null for anything that isn't a JSON object carrying a finite
 * numeric `id`, including a line over the length cap, mirroring the checks
 * `parseRequestLine` itself makes before it would even look at `id`.
 */
function recoverId(line: string): number | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return null
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const id = (value as { id?: unknown }).id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/**
 * Serves browser tool requests on a unix socket, one line in and one line
 * out per request.
 *
 * Holds no state of its own beyond the connections it is serving: what a
 * request means and how to carry it out is the handler's job, passed in at
 * construction. That is what makes it testable against a raw socket with no
 * app around it.
 *
 * Unlike `HookServer`, every request that parses gets a response: the bridge
 * on the other end is waiting on that `id` and has no other way to learn a
 * call failed. A handler's rejection becomes `ok: false` with its message
 * rather than dropping the connection, and a line that fails to parse still
 * gets an error response when its `id` can be recovered, because the bridge
 * is still waiting either way.
 */
export class McpServer {
  private server: Server | null = null
  private socketPath: string | null = null
  /**
   * The connections being served right now, so `close` can end them.
   *
   * `net.Server#close` stops accepting and then waits for every live
   * connection to end on its own. That is the right default for a process on
   * its way out, and the wrong one for the off switch: measured 2026-08-12,
   * `setMcpEnabled(false, …)` against a handler that had not answered yet
   * never returned at all, so the click that turned the bridge off hung.
   * Destroying them instead bounds it, and what the caller on the other end
   * sees is a close with no response, which the bridge script reports to the
   * model as a call pTerm did not answer rather than a wait to its own 30s
   * timeout.
   */
  private readonly connections = new Set<Socket>()

  constructor(private readonly handler: (request: McpRequest) => Promise<unknown>) {}

  async listen(path: string): Promise<void> {
    if (this.server) return
    if (Buffer.byteLength(path, 'utf8') > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `McpServer: socket path is too long for macOS (${Buffer.byteLength(path, 'utf8')} bytes, ` +
          `limit ${MAX_SOCKET_PATH_BYTES}): ${path}`,
      )
    }

    const attempt = (): Promise<Server> =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer((connection) => this.accept(connection))
        server.once('error', reject)
        server.listen(path, () => {
          server.removeListener('error', reject)
          resolve(server)
        })
      })

    try {
      this.server = await attempt()
      this.socketPath = path
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }

    // A unix socket file outlives the process that created it, so a crash
    // leaves one behind and `listen` fails EADDRINUSE on the next launch;
    // that failure alone does not say which of those two this is. Probing
    // first tells them apart: a live process answering means genuinely in
    // use, so this refuses loudly instead of stealing the socket out from
    // under it.
    if (await probeListening(path)) {
      throw new Error(`McpServer: ${path} is already in use by another live process. Refusing to steal it.`)
    }
    await rm(path, { force: true })
    this.server = await attempt()
    this.socketPath = path
  }

  private accept(connection: Socket): void {
    let buffer = ''
    this.connections.add(connection)
    connection.once('close', () => this.connections.delete(connection))
    connection.setEncoding('utf8')
    // Swallowed rather than rethrown: a reset connection would otherwise
    // surface as an uncaught 'error' event and take the process down with it.
    connection.on('error', () => connection.destroy())

    const respond = (response: McpResponse): void => {
      if (connection.destroyed) return
      connection.write(formatResponseLine(response))
    }

    // Requests on one connection are handled one at a time, in arrival
    // order: the bridge sends id 1 then id 2 on the same socket and reads
    // responses off the same stream, so answering out of order or letting a
    // slow handler's response overtake a fast one's would desynchronise it.
    let queue: Promise<void> = Promise.resolve()

    const take = (line: string): void => {
      const request = parseRequestLine(line)
      if (request) {
        queue = queue.then(async () => {
          try {
            const result = await this.handler(request)
            respond({ id: request.id, ok: true, result })
          } catch (error) {
            respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })
        return
      }

      // Everything arriving here is untrusted. A line that fails to parse is
      // dropped only when it carries no recoverable id: the bridge cannot be
      // waiting on an id it never learns, so there is nothing to answer.
      const id = recoverId(line)
      if (id === null) return
      queue = queue.then(() => {
        respond({ id, ok: false, error: 'malformed request' })
      })
    }

    connection.on('data', (chunk: string) => {
      const framed = takeLines(buffer, chunk)
      for (const line of framed.lines) take(line)
      buffer = framed.held
    })

    connection.on('close', () => {
      if (buffer.length > 0) take(buffer)
      buffer = ''
    })
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    // Both, and in this order: `close` is what stops it accepting, and
    // destroying the live connections is what lets that finish. See
    // `connections`.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    for (const connection of this.connections) connection.destroy()
    this.connections.clear()
    await closed
    if (this.socketPath) await rm(this.socketPath, { force: true })
    this.socketPath = null
  }
}
