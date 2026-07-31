import { describe, it, expect, afterEach } from 'vitest'
import { connect, createServer } from 'node:net'
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HookServer } from '../../src/main/hooks/server'
import type { HookEventMessage } from '../../src/main/hooks/protocol'
import { renderScript } from '../../src/main/hooks/install'

const exec = promisify(execFile)

const ID = '0123456789abcdef'

let dir: string
let server: HookServer | null = null

async function start(): Promise<{ server: HookServer; socket: string; seen: HookEventMessage[] }> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
  const socket = join(dir, 'hook.sock')
  const seen: HookEventMessage[] = []
  server = new HookServer(socket)
  server.onEvent((message) => seen.push(message))
  await server.start()
  return { server, socket, seen }
}

/** Write raw bytes the way the hook script does and close. */
function send(socket: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.end(payload))
    client.on('close', () => resolve())
    client.on('error', reject)
  })
}

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

afterEach(async () => {
  await server?.stop()
  server = null
  await rm(dir, { recursive: true, force: true })
})

describe('HookServer', () => {
  it('emits a well-formed event', async () => {
    const { socket, seen } = await start()

    await send(socket, `{"tabId":"${ID}","event":"Notification","at":5}\n`)

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]).toEqual({ tabId: ID, event: 'Notification', at: 5 })
  })

  it('handles several events on one connection', async () => {
    const { socket, seen } = await start()

    await send(
      socket,
      `{"tabId":"${ID}","event":"Stop","at":1}\n{"tabId":"${ID}","event":"Notification","at":2}\n`,
    )

    await expect.poll(() => seen.length).toBe(2)
    expect(seen.map((event) => event.event)).toEqual(['Stop', 'Notification'])
  })

  it('handles a line split across two writes', async () => {
    const { socket, seen } = await start()

    await new Promise<void>((resolve, reject) => {
      const client = connect(socket, () => {
        client.write(`{"tabId":"${ID}","event":"St`)
        setTimeout(() => client.end(`op","at":3}\n`), 20)
      })
      client.on('close', () => resolve())
      client.on('error', reject)
    })

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]?.event).toBe('Stop')
  })

  it('handles a line split across many small writes', async () => {
    // Attacks the buffering loop directly: does accumulating a legitimate
    // line across dozens of tiny 'data' events lose bytes, or trip the
    // MAX_BUFFER_BYTES clear meant for a line that will never end? A real
    // line is far under that ceiling (MAX_LINE_BYTES=512 vs the 128x margin
    // server.ts gives itself), so it shouldn't — this proves it rather than
    // assuming the arithmetic.
    const { socket, seen } = await start()
    const line = `{"tabId":"${ID}","event":"Stop","at":12345}\n`

    await new Promise<void>((resolve, reject) => {
      const client = connect(socket, () => {
        let index = 0
        const pump = (): void => {
          if (index >= line.length) {
            client.end()
            return
          }
          client.write(line[index])
          index += 1
          setImmediate(pump)
        }
        pump()
      })
      client.on('close', () => resolve())
      client.on('error', reject)
    })

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]).toEqual({ tabId: ID, event: 'Stop', at: 12345 })
  })

  it('emits a final line that arrived without a newline', async () => {
    const { socket, seen } = await start()

    await send(socket, `{"tabId":"${ID}","event":"Stop","at":4}`)

    await expect.poll(() => seen.length).toBe(1)
  })

  it(
    'flushes a dangling partial line when the server closes an idle connection, not just on a clean end',
    async () => {
      // The brief's server only flushed the trailing partial line on the
      // socket's 'end' event. 'end' fires when the *remote* side signals it
      // is done writing — it does not fire when *we* unilaterally destroy a
      // connection, which is exactly what the idle timeout above does to a
      // client that writes and then goes quiet. Verified directly against
      // Node before writing this test: a server-side destroy() with no
      // prior client close produces a 'close' event with no preceding
      // 'end' at all, so a line sitting in the buffer at that moment was
      // silently lost under the brief's version. Flushing on 'close'
      // instead — which fires after 'end' too — catches both paths without
      // reading a completed line twice.
      const { socket, seen } = await start()

      await new Promise<void>((resolve, reject) => {
        const client = connect(socket, () => {
          client.write(`{"tabId":"${ID}","event":"Stop","at":7}`)
          // Deliberately never end() or destroy() the client — only the
          // server's own idle timeout closes this connection.
        })
        client.on('close', () => resolve())
        client.on('error', reject)
      })

      await expect.poll(() => seen.length, { timeout: 6_000 }).toBe(1)
      expect(seen[0]).toEqual({ tabId: ID, event: 'Stop', at: 7 })
    },
    8_000,
  )

  // Reachable by anything on the machine that can open the socket. None of
  // this may throw, and none of it may take the server down.
  it('survives garbage without dying, and keeps serving after it', async () => {
    const { socket, seen } = await start()

    await send(socket, 'not json\n')
    await send(socket, '{"tabId":"zzz","event":"Stop","at":1}\n')
    await send(socket, `{"tabId":"${ID}","event":"Nope","at":1}\n`)
    await send(socket, `${'x'.repeat(50_000)}\n`)
    await send(socket, `{"tabId":"${ID}","event":"Stop","at":9}\n`)

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]?.at).toBe(9)
  })

  it('drops an over-long line without buffering it without limit', async () => {
    const { socket, seen } = await start()

    // A single line far larger than the cap, with no newline in it at all —
    // the shape that would grow a buffer forever if nothing bounded it.
    await send(socket, 'y'.repeat(200_000))

    await expect.poll(() => seen.length, { timeout: 2_000 }).toBe(0)
  })

  it('keeps reading the same connection after a garbage overflow is dropped', async () => {
    // The over-long-line test above opens a fresh connection per send(), so
    // it never proves the per-connection buffer variable itself recovers.
    // This keeps one connection open across the overflow and a legitimate
    // line that follows it, on purpose.
    const { socket, seen } = await start()

    await new Promise<void>((resolve, reject) => {
      const client = connect(socket, () => {
        client.write('z'.repeat(200_000))
        client.end(`\n{"tabId":"${ID}","event":"Stop","at":11}\n`)
      })
      client.on('close', () => resolve())
      client.on('error', reject)
    })

    await expect.poll(() => seen.length, { timeout: 2_000 }).toBe(1)
    expect(seen[0]).toEqual({ tabId: ID, event: 'Stop', at: 11 })
  })

  it('replaces a stale socket file left by a crash', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const socket = join(dir, 'hook.sock')
    // Not a real socket, just a file in the way — which is what a crashed
    // process leaves behind and what makes listen() fail EADDRINUSE.
    await writeFile(socket, 'stale', 'utf8')

    server = new HookServer(socket)
    await expect(server.start()).resolves.toBeUndefined()
  })

  // M2: the old comment justified an unconditional unlink-before-bind with
  // "safe only because requestSingleInstanceLock guarantees there is no
  // second live instance" — a guarantee the ledger's own notes record as
  // false on this exact machine, where a packaged /Applications/PRCLI.app
  // and a dev `electron-forge start` are different app identities and each
  // acquires its own lock. Under that real condition, unlinking
  // unconditionally would steal the socket out from under the first
  // instance, which would then go deaf with no error anywhere.
  it('does not steal a socket a live process is actually using', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const socket = join(dir, 'hook.sock')

    // A real listener on the path — stands in for a second live instance —
    // not the plain-file stand-in the "stale socket" test above uses. Its
    // connection handler destroys immediately: this test only needs to prove
    // the *bind* survives, not exercise a full protocol round trip.
    const owner = createServer((c) => c.destroy())
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject)
      owner.listen(socket, () => {
        owner.removeAllListeners('error')
        resolve()
      })
    })

    try {
      server = new HookServer(socket)
      await expect(server.start()).rejects.toThrow(/already in use/i)
      server = null

      // Still bound to `owner` — not unlinked out from under it. A fresh
      // connection succeeding is proof: an unlinked-and-abandoned path would
      // refuse it (ENOENT) instead.
      await expect(
        new Promise<void>((resolve, reject) => {
          const probe = connect(socket)
          probe.once('connect', () => {
            probe.destroy()
            resolve()
          })
          probe.once('error', reject)
        }),
      ).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => owner.close(() => resolve()))
    }
  })

  it('says plainly when the path is too long for a unix socket', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const deep = join(dir, 'a'.repeat(60), 'b'.repeat(60))
    await mkdir(deep, { recursive: true })
    const socket = join(deep, 'hook.sock')

    server = new HookServer(socket)
    // Not a bare EINVAL from bind(2), which says nothing about what to change.
    await expect(server.start()).rejects.toThrow(/too long/i)
    server = null
  })

  it('accepts a path at exactly the measured macOS ceiling (104 bytes)', async () => {
    // Verified directly against this machine rather than taken from the
    // textbook `sun_path[104]` struct field: listen() on a 104-byte path
    // succeeds here, so 104 — not 103 — is the real usable ceiling.
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const socket = socketOfLength(dir, 104)
    expect(Buffer.byteLength(socket, 'utf8')).toBe(104)

    server = new HookServer(socket)
    await expect(server.start()).resolves.toBeUndefined()
  })

  it('rejects a path one byte past the measured macOS ceiling (105 bytes)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const socket = socketOfLength(dir, 105)
    expect(Buffer.byteLength(socket, 'utf8')).toBe(105)

    server = new HookServer(socket)
    await expect(server.start()).rejects.toThrow(/too long/i)
    server = null
  })

  it('can be stopped and started again on the same path', async () => {
    const { socket, seen } = await start()
    await server?.stop()
    await server?.start()

    await send(socket, `{"tabId":"${ID}","event":"Stop","at":1}\n`)

    await expect.poll(() => seen.length).toBe(1)
  })

  it('keeps serving other listeners when one listener throws', async () => {
    // onEvent is a trust boundary too: Task 11's registry doesn't exist yet
    // to have been proven not to throw, and a socket full of hooks firing
    // seven times a turn across twelve sessions is not somewhere a single
    // bad event should be able to take the whole server down.
    const { socket, seen } = await start()
    const survived: HookEventMessage[] = []
    server?.onEvent(() => {
      throw new Error('a hypothetical registry bug')
    })
    server?.onEvent((message) => survived.push(message))

    await send(socket, `{"tabId":"${ID}","event":"Stop","at":1}\n`)
    await send(socket, `{"tabId":"${ID}","event":"Notification","at":2}\n`)

    await expect.poll(() => seen.length).toBe(2)
    expect(survived.map((message) => message.event)).toEqual(['Stop', 'Notification'])
  })

  it('receives what the real hook script sends', async () => {
    const { socket, seen } = await start()
    const script = join(dir, 'prcli-hook')
    await writeFile(script, renderScript({ socket, spool: join(dir, 'hook.spool') }), 'utf8')
    await chmod(script, 0o755)

    await exec(script, ['UserPromptSubmit'], {
      env: { PATH: process.env.PATH ?? '', PRCLI_TAB_ID: ID },
    })

    await expect.poll(() => seen.length, { timeout: 4_000 }).toBe(1)
    expect(seen[0]?.event).toBe('UserPromptSubmit')
    expect(seen[0]?.at).toBeGreaterThan(1_700_000_000_000)
  })
})
