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
      throw new Error(`McpServer: ${path} is already in use by another live process — refusing to steal it.`)
    }
    await rm(path, { force: true })
    this.server = await attempt()
    this.socketPath = path
  }

  private accept(connection: Socket): void {
    let buffer = ''
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
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        take(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      // No newline in sight and already past the ceiling: this is not a line
      // that is going to arrive. Drop what is held rather than keep growing.
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) buffer = ''
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
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.socketPath) await rm(this.socketPath, { force: true })
    this.socketPath = null
  }
}
