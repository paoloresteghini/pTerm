import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { MAX_LINE_BYTES, parseHookLine, type HookEventMessage } from './protocol'

/**
 * macOS caps a unix socket path (`sun_path`) near 104 bytes. Past it, `bind`
 * fails with a bare `EINVAL` that says nothing about the length — which is
 * exactly the failure a deep `PRCLI_CONFIG_DIR` under a temp directory would
 * produce in CI.
 *
 * 104, not 103: measured directly against this machine's kernel (Darwin,
 * Node v25) rather than assumed from the textbook `sun_path[104]` struct
 * field, because that field's size is not automatically the usable string
 * length — it depends on whether the implementation needs room for a
 * trailing NUL inside the array or carries the length out-of-band instead.
 * `net.Server#listen` on a path of exactly 104 bytes here succeeds; 105
 * fails `EINVAL`. So 104 is the real ceiling, not one less.
 */
const MAX_SOCKET_PATH_BYTES = 104

/**
 * Enough for a great many well-formed lines, and a hard ceiling on what one
 * connection can make the process hold. A client that sends no newline at all
 * is the shape that would otherwise grow a buffer forever.
 *
 * The margin over `MAX_LINE_BYTES` (128x) is deliberate, not generous by
 * accident: a legitimate line can never itself be long enough to trigger the
 * clear below, so the clear only ever fires on a line this server was always
 * going to reject once it saw a newline. Nothing legitimate loses its front.
 */
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 128

/**
 * Listens for hook events on a unix socket.
 *
 * Holds no state and decides nothing: it parses lines and emits them. What a
 * state means is the machine's job, and which tab it belongs to is the
 * registry's. That is what makes it testable against a raw socket with no app
 * around it.
 *
 * Everything arriving here is untrusted — the socket is reachable by anything
 * on the machine that can open it — so a bad line is dropped and the
 * connection carries on. Nothing a client can send may take the server down,
 * and neither may a listener registered by `onEvent`: this is a trust
 * boundary in both directions, and Task 11's registry does not exist yet to
 * have been proven not to throw.
 */
export class HookServer {
  private server: Server | null = null
  private readonly listeners = new Set<(message: HookEventMessage) => void>()

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    if (this.server) return
    if (Buffer.byteLength(this.socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `HookServer: socket path is too long for macOS (${Buffer.byteLength(this.socketPath, 'utf8')} bytes, ` +
          `limit ${MAX_SOCKET_PATH_BYTES}): ${this.socketPath}. Set PRCLI_CONFIG_DIR to a shorter path.`,
      )
    }

    // A unix socket file outlives the process that created it, so a crash
    // leaves one behind and `listen` fails EADDRINUSE on the next launch.
    // Removing it is safe only because `requestSingleInstanceLock` guarantees
    // there is no second live instance to steal the socket from.
    await rm(this.socketPath, { force: true })

    const server = createServer((connection) => this.accept(connection))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  private accept(connection: Socket): void {
    let buffer = ''
    connection.setEncoding('utf8')
    // A hook writes and hangs up; it never reads. Anything that connects and
    // stays silent should not hold a handle open indefinitely.
    connection.setTimeout(5_000, () => connection.destroy())
    // Swallowed rather than rethrown: a reset connection would otherwise
    // surface as an uncaught 'error' event and take the process down with it.
    // `close` below (which always follows, error or not) is where any bytes
    // this connection managed to deliver still get a chance to be read.
    connection.on('error', () => connection.destroy())

    const take = (line: string): void => {
      const message = parseHookLine(line)
      if (!message) return
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch {
          // A listener's bug is not this connection's problem, and must not
          // stop the remaining listeners from seeing the event either.
        }
      }
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

    // Not 'end': a hook script's write is backgrounded and can be cut off by
    // a reset as easily as it can finish cleanly, and a final line with no
    // trailing newline deserves the same chance to be read either way.
    // 'close' fires exactly once no matter which path got the connection
    // here — a graceful end, our own idle timeout, or the 'error' handler's
    // destroy() above — so flushing there, and only there, reads a real
    // trailing partial line once and never reads a completed one twice.
    connection.on('close', () => {
      if (buffer.length > 0) take(buffer)
      buffer = ''
    })
  }

  onEvent(listener: (message: HookEventMessage) => void): void {
    this.listeners.add(listener)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.socketPath, { force: true })
  }
}
