# PRCLI Milestone 1 — Terminal Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron app that renders a single working terminal backed by a detached tmux session, which survives quitting and relaunching the app with scrollback intact.

**Architecture:** Electron main process owns all session state. Each terminal is a `tmux` session named `prcli-<slug>-<id>`; the app attaches to it through a `node-pty` process running the `tmux` client. Killing that client detaches without killing the session, so processes outlive the app. The renderer is a dumb view: xterm.js instances wired to the main process over typed IPC.

**Tech Stack:** Electron 43.2.0, TypeScript, Vite (via Electron Forge 7.11.2), node-pty 1.1.0, @xterm/xterm 6.0.0, React 19, Vitest 4.1.10, Playwright 1.62.0, tmux ≥ 3.3.

## Global Constraints

- Platform: macOS only. No Windows or Linux branches.
- Exact dependency versions: `electron@43.2.0`, `node-pty@1.1.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`, `@xterm/addon-webgl@0.19.0`, `vitest@4.1.10`, `@playwright/test@1.62.0`.
- `node-pty` is a native module. It must be listed in Vite's `build.rollupOptions.external` for the main process, and never imported from the renderer.
- Every tmux session name is `prcli-<projectSlug>-<id>` where `projectSlug` matches `^[a-z0-9_]+$` and `id` matches `^[0-9a-f]{16}$`. This is the only naming scheme; nothing else may construct these strings by hand.
- All tmux invocations go through `TmuxAdapter`. No `execFile('tmux', …)` anywhere else.
- Integration tests use a dedicated tmux socket (`-L prcli-test`) so they can never touch the developer's own tmux server.
- Renderer code never imports Node built-ins. All privileged access goes through the preload `contextBridge`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-07-30-prcli-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `forge.config.ts` | Electron Forge config; native module unpacking |
| `vite.main.config.ts` | Main bundle; marks `node-pty` external |
| `vite.preload.config.ts` | Preload bundle |
| `vite.renderer.config.ts` | Renderer bundle |
| `vitest.config.ts` | Unit + integration test config |
| `playwright.config.ts` | E2E config |
| `src/shared/ipc.ts` | IPC channel names and payload types, shared by all three processes |
| `src/main/tmux/names.ts` | Pure session-name encode/decode/slugify. No I/O |
| `src/main/tmux/adapter.ts` | Thin wrapper over the `tmux` CLI: version, list, has, kill |
| `src/main/pty/session.ts` | One attached tmux client as a PTY: data, write, resize, detach |
| `src/main/sessions/manager.ts` | Registry of open sessions; open, adopt, detach, kill |
| `src/main/state/store.ts` | Persists `~/.prcli/config.json` atomically |
| `src/main/ipc/register.ts` | Binds `SessionManager` to IPC channels |
| `src/main/index.ts` | App lifecycle, window creation, wiring |
| `src/preload/index.ts` | `contextBridge` API surface |
| `src/renderer/Terminal.tsx` | xterm.js instance bound to one session id |
| `src/renderer/App.tsx` | Renders the restored or newly created session |
| `tests/unit/names.test.ts` | Pure name logic |
| `tests/integration/adapter.test.ts` | `TmuxAdapter` against real tmux |
| `tests/integration/session.test.ts` | `PtySession` against real tmux |
| `tests/integration/manager.test.ts` | `SessionManager` lifecycle and adoption |
| `tests/unit/store.test.ts` | Config persistence |
| `tests/e2e/launch.spec.ts` | App launches, terminal echoes, survives relaunch |

---

### Task 1: Project scaffold and toolchain

Produces a running Electron window and a green (empty) test run. Nothing else works yet.

**Files:**
- Create: `package.json`, `forge.config.ts`, `vite.main.config.ts`, `vite.preload.config.ts`, `vite.renderer.config.ts`, `tsconfig.json`, `vitest.config.ts`, `index.html`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
- Test: `tests/unit/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm start` (dev app), `npm test` (vitest), `npm run typecheck`

- [ ] **Step 1: Install tmux**

```bash
brew install tmux
tmux -V
```

Expected: `tmux 3.5a` or newer. The app refuses to run without it.

- [ ] **Step 2: Scaffold Electron Forge with Vite + TypeScript**

Run from `/Users/paolo/Code/PRCLI`. The scaffolder needs an empty-ish directory, so generate into a temp dir and move the files in:

```bash
cd /tmp && rm -rf prcli-scaffold
npx -y create-electron-app@latest prcli-scaffold --template=vite-typescript
cd /Users/paolo/Code/PRCLI
cp -R /tmp/prcli-scaffold/{package.json,forge.config.ts,vite.main.config.ts,vite.preload.config.ts,vite.renderer.config.ts,tsconfig.json,index.html,src} .
rm -rf /tmp/prcli-scaffold
```

- [ ] **Step 3: Pin dependencies**

```bash
npm pkg set name="prcli" version="0.1.0" productName="PRCLI"
npm i -E electron@43.2.0
npm i -E node-pty@1.1.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-webgl@0.19.0
npm i -E react@19.2.0 react-dom@19.2.0
npm i -DE vitest@4.1.10 @playwright/test@1.62.0 @vitejs/plugin-react@5.0.4
npm i -DE @types/react@19.2.2 @types/react-dom@19.2.1
npm i -DE @electron-forge/plugin-auto-unpack-natives@7.11.2
```

- [ ] **Step 4: Mark node-pty external in the main bundle**

Replace `vite.main.config.ts` entirely:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      // node-pty is a native module — it must be require()d at runtime,
      // never bundled. Bundling it produces "Cannot find module ...node".
      external: ['node-pty'],
    },
  },
})
```

- [ ] **Step 5: Enable native module unpacking in Forge**

In `forge.config.ts`, add the plugin to the `plugins` array (keep the existing Vite plugin entry):

```ts
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'

// inside config.plugins, as the first entry:
new AutoUnpackNativesPlugin({}),
```

Also set, inside `packagerConfig`:

```ts
asar: true,
```

- [ ] **Step 6: Add React to the renderer**

Replace `vite.renderer.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

Create `src/renderer/App.tsx`:

```tsx
export function App() {
  return <div style={{ color: '#a1a1aa', fontFamily: 'monospace', padding: 16 }}>PRCLI</div>
}
```

Create `src/renderer/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')
createRoot(el).render(<App />)
```

Replace the body of `index.html` with:

```html
<body style="margin:0;background:#09090b">
  <div id="root"></div>
  <script type="module" src="/src/renderer/main.tsx"></script>
</body>
```

Delete the scaffold's `src/renderer.ts` and any `import './renderer'` line if present.

- [ ] **Step 7: Add test config and scripts**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Integration tests drive a real tmux server; running files in parallel
    // makes session lists non-deterministic.
    fileParallelism: false,
    testTimeout: 15_000,
  },
})
```

```bash
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.e2e="playwright test"
```

- [ ] **Step 8: Write the smoke test**

Create `tests/unit/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 9: Verify the toolchain**

```bash
npm test
npm run typecheck
```

Expected: 1 test passes, typecheck clean.

- [ ] **Step 10: Verify the app launches and node-pty loads**

Add to `src/main/index.ts`, immediately after the existing imports:

```ts
// Fails loudly at boot if the native module was not rebuilt for Electron's ABI.
import { spawn as ptySpawn } from 'node-pty'
console.log('node-pty loaded:', typeof ptySpawn === 'function')
```

```bash
npm start
```

Expected: a window appears showing `PRCLI`, and the terminal running `npm start` logs `node-pty loaded: true`.

If it instead throws `NODE_MODULE_VERSION` mismatch or `Cannot find module`, rebuild against Electron and relaunch:

```bash
npx -y @electron/rebuild -f -w node-pty
npm start
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Scaffold Electron + Vite + React app with node-pty

Pins exact dependency versions, marks node-pty external so the native
module is required at runtime rather than bundled, and adds vitest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: tmux session naming

Pure functions, no I/O. Everything downstream depends on these names being unambiguous.

**Files:**
- Create: `src/main/tmux/names.ts`
- Test: `tests/unit/names.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SESSION_PREFIX: 'prcli'`
  - `slugify(name: string): string`
  - `newSessionId(): string`
  - `encodeSessionName(parts: { projectSlug: string; id: string }): string`
  - `decodeSessionName(name: string): { projectSlug: string; id: string } | null`
  - `isPrcliSession(name: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/names.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  slugify,
  newSessionId,
  encodeSessionName,
  decodeSessionName,
  isPrcliSession,
} from '../../src/main/tmux/names'

describe('slugify', () => {
  it('lowercases and replaces unsafe characters with underscores', () => {
    expect(slugify('HartfordRents')).toBe('hartfordrents')
    expect(slugify('Hartford Rents Web')).toBe('hartford_rents_web')
    expect(slugify('REKUPR-b1b2')).toBe('rekupr_b1b2')
    expect(slugify('ginos-estate-agents')).toBe('ginos_estate_agents')
  })

  it('collapses runs of unsafe characters into one underscore', () => {
    expect(slugify('a  --  b')).toBe('a_b')
  })

  it('trims leading and trailing underscores', () => {
    expect(slugify('  Lumio  ')).toBe('lumio')
  })

  it('throws when nothing usable remains', () => {
    expect(() => slugify('...')).toThrow(/no usable characters/i)
  })
})

describe('newSessionId', () => {
  it('produces 16 lowercase hex characters', () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces distinct ids', () => {
    expect(newSessionId()).not.toBe(newSessionId())
  })
})

describe('encodeSessionName', () => {
  it('joins prefix, slug and id with dashes', () => {
    expect(encodeSessionName({ projectSlug: 'lumio', id: 'a1b2c3d4e5f60718' }))
      .toBe('prcli-lumio-a1b2c3d4e5f60718')
  })

  it('rejects a slug that is not already sanitised', () => {
    expect(() => encodeSessionName({ projectSlug: 'Lumio-Web', id: 'a1b2c3d4e5f60718' }))
      .toThrow(/invalid project slug/i)
  })

  it('rejects a malformed id', () => {
    expect(() => encodeSessionName({ projectSlug: 'lumio', id: 'nope' }))
      .toThrow(/invalid session id/i)
  })
})

describe('decodeSessionName', () => {
  it('round-trips an encoded name', () => {
    const parts = { projectSlug: 'hartford_rents', id: '00112233445566aa' }
    expect(decodeSessionName(encodeSessionName(parts))).toEqual(parts)
  })

  it('returns null for foreign session names', () => {
    expect(decodeSessionName('0')).toBeNull()
    expect(decodeSessionName('work')).toBeNull()
    expect(decodeSessionName('prcli')).toBeNull()
    expect(decodeSessionName('other-lumio-a1b2c3d4e5f60718')).toBeNull()
  })

  it('returns null when the id is malformed', () => {
    expect(decodeSessionName('prcli-lumio-XYZ')).toBeNull()
  })
})

describe('isPrcliSession', () => {
  it('distinguishes ours from foreign sessions', () => {
    expect(isPrcliSession('prcli-lumio-a1b2c3d4e5f60718')).toBe(true)
    expect(isPrcliSession('my-work-session')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/names.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/tmux/names"`.

- [ ] **Step 3: Implement**

Create `src/main/tmux/names.ts`:

```ts
import { randomBytes } from 'node:crypto'

export const SESSION_PREFIX = 'prcli'

const SLUG_RE = /^[a-z0-9_]+$/
const ID_RE = /^[0-9a-f]{16}$/

export interface SessionNameParts {
  projectSlug: string
  id: string
}

/**
 * Reduce a display name to a session-safe slug. Lossy and deliberately so:
 * the slug is the project's identity everywhere in PRCLI, and the display
 * name is stored separately in config.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (slug.length === 0) {
    throw new Error(`slugify: no usable characters in ${JSON.stringify(name)}`)
  }
  return slug
}

export function newSessionId(): string {
  return randomBytes(8).toString('hex')
}

export function encodeSessionName({ projectSlug, id }: SessionNameParts): string {
  if (!SLUG_RE.test(projectSlug)) {
    throw new Error(`encodeSessionName: invalid project slug ${JSON.stringify(projectSlug)}`)
  }
  if (!ID_RE.test(id)) {
    throw new Error(`encodeSessionName: invalid session id ${JSON.stringify(id)}`)
  }
  return `${SESSION_PREFIX}-${projectSlug}-${id}`
}

/**
 * Slugs contain no dashes and ids are hex, so an encoded name always splits
 * into exactly three dash-separated parts. That is what makes this decodable.
 */
export function decodeSessionName(name: string): SessionNameParts | null {
  const parts = name.split('-')
  if (parts.length !== 3) return null
  const [prefix, projectSlug, id] = parts
  if (prefix !== SESSION_PREFIX) return null
  if (!SLUG_RE.test(projectSlug) || !ID_RE.test(id)) return null
  return { projectSlug, id }
}

export function isPrcliSession(name: string): boolean {
  return decodeSessionName(name) !== null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/names.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/tmux/names.ts tests/unit/names.test.ts
git commit -m "$(cat <<'EOF'
Add tmux session naming

Slugs are dash-free and ids are hex, so prcli-<slug>-<id> always splits
into exactly three parts and decodes unambiguously.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: TmuxAdapter

The only place in the codebase that shells out to `tmux`.

**Files:**
- Create: `src/main/tmux/adapter.ts`
- Test: `tests/integration/adapter.test.ts`

**Interfaces:**
- Consumes: `isPrcliSession` from Task 2
- Produces:
  - `class TmuxNotInstalledError extends Error`
  - `class TmuxAdapter { constructor(opts?: { bin?: string; socket?: string }); baseArgs(): string[]; bin: string; version(): Promise<string>; listSessions(): Promise<string[]>; listPrcliSessions(): Promise<string[]>; hasSession(name: string): Promise<boolean>; killSession(name: string): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/adapter.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TmuxAdapter, TmuxNotInstalledError } from '../../src/main/tmux/adapter'

const run = promisify(execFile)
const SOCKET = 'prcli-test'
const adapter = new TmuxAdapter({ socket: SOCKET })

async function createSession(name: string): Promise<void> {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', name, 'sleep', '600'])
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running — nothing to clean up.
  }
}

beforeAll(killServer)
afterEach(killServer)

describe('TmuxAdapter.version', () => {
  it('returns the tmux version string', async () => {
    await expect(adapter.version()).resolves.toMatch(/^tmux /)
  })

  it('throws TmuxNotInstalledError when the binary is missing', async () => {
    const missing = new TmuxAdapter({ bin: '/nonexistent/tmux', socket: SOCKET })
    await expect(missing.version()).rejects.toBeInstanceOf(TmuxNotInstalledError)
  })
})

describe('TmuxAdapter.listSessions', () => {
  it('returns an empty array when no server is running', async () => {
    await expect(adapter.listSessions()).resolves.toEqual([])
  })

  it('lists session names', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await createSession('someone-elses-session')
    const names = await adapter.listSessions()
    expect(names.sort()).toEqual(['prcli-lumio-a1b2c3d4e5f60718', 'someone-elses-session'])
  })
})

describe('TmuxAdapter.listPrcliSessions', () => {
  it('excludes sessions that are not ours', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await createSession('someone-elses-session')
    await expect(adapter.listPrcliSessions()).resolves.toEqual([
      'prcli-lumio-a1b2c3d4e5f60718',
    ])
  })
})

describe('TmuxAdapter.hasSession', () => {
  it('is true for an existing session and false otherwise', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
    await expect(adapter.hasSession('prcli-lumio-000000000000000f')).resolves.toBe(false)
  })

  it('does not match on prefix', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio')).resolves.toBe(false)
  })
})

describe('TmuxAdapter.killSession', () => {
  it('removes the session', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await adapter.killSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('is a no-op for a session that does not exist', async () => {
    await expect(adapter.killSession('prcli-lumio-000000000000000f')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: FAIL — cannot resolve `../../src/main/tmux/adapter`.

- [ ] **Step 3: Implement**

Create `src/main/tmux/adapter.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isPrcliSession } from './names'

const run = promisify(execFile)

export class TmuxNotInstalledError extends Error {
  constructor(message = 'tmux is not installed or not on PATH') {
    super(message)
    this.name = 'TmuxNotInstalledError'
  }
}

export interface TmuxAdapterOptions {
  bin?: string
  /** tmux server socket name. Tests pass one so they never touch the user's server. */
  socket?: string
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function stderrOf(error: unknown): string {
  const value = (error as { stderr?: unknown } | undefined)?.stderr
  return typeof value === 'string' ? value : ''
}

export class TmuxAdapter {
  readonly bin: string
  private readonly socket?: string

  constructor(options: TmuxAdapterOptions = {}) {
    this.bin = options.bin ?? 'tmux'
    this.socket = options.socket
  }

  /** Args that must precede every tmux subcommand. PtySession needs these too. */
  baseArgs(): string[] {
    return this.socket ? ['-L', this.socket] : []
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(this.bin, [...this.baseArgs(), ...args])
      return stdout
    } catch (error) {
      if (isEnoent(error)) throw new TmuxNotInstalledError()
      throw error
    }
  }

  async version(): Promise<string> {
    return (await this.exec(['-V'])).trim()
  }

  async listSessions(): Promise<string[]> {
    try {
      const stdout = await this.exec(['list-sessions', '-F', '#{session_name}'])
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch (error) {
      // "no server running on ..." is the normal empty case, not a failure.
      if (/no server running/i.test(stderrOf(error))) return []
      throw error
    }
  }

  async listPrcliSessions(): Promise<string[]> {
    return (await this.listSessions()).filter(isPrcliSession)
  }

  /** `=name` is tmux's exact-match syntax; without it `prcli-lumio` matches by prefix. */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.exec(['has-session', '-t', `=${name}`])
      return true
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      return false
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.exec(['kill-session', '-t', `=${name}`])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      // Killing something already gone is success. Anything else is not.
      if (await this.hasSession(name)) throw error
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify tests did not touch your own tmux server**

Run: `tmux ls`
Expected: `no server running on /tmp/tmux-501/default` (or your own unrelated sessions). No `prcli-*` entries.

- [ ] **Step 6: Commit**

```bash
git add src/main/tmux/adapter.ts tests/integration/adapter.test.ts
git commit -m "$(cat <<'EOF'
Add TmuxAdapter

Wraps the tmux CLI for version, list, has-session and kill-session.
Supports an alternate socket so integration tests run against their own
tmux server.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: PtySession

One attached tmux client, as a PTY. This is the task where detach-vs-kill semantics are established.

**Files:**
- Create: `src/main/pty/session.ts`
- Test: `tests/integration/session.test.ts`

**Interfaces:**
- Consumes: `TmuxAdapter` from Task 3 (for `bin` and `baseArgs()`)
- Produces:
  - `interface PtySessionOptions { tmuxSession: string; cwd: string; cols: number; rows: number; command?: string; env?: NodeJS.ProcessEnv }`
  - `class PtySession { constructor(adapter: TmuxAdapter, options: PtySessionOptions); readonly tmuxSession: string; start(): void; write(data: string): void; resize(cols: number, rows: number): void; detach(): void; onData(listener: (data: string) => void): void; onExit(listener: (code: number) => void): void }`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/session.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { PtySession } from '../../src/main/pty/session'

const run = promisify(execFile)
const SOCKET = 'prcli-test'
const adapter = new TmuxAdapter({ socket: SOCKET })
const NAME = 'prcli-lumio-a1b2c3d4e5f60718'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

/** Collect output until `match` appears, or reject after `ms`. */
function waitForOutput(session: PtySession, match: RegExp, ms = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${match}; saw: ${JSON.stringify(buffer)}`)),
      ms,
    )
    session.onData((data) => {
      buffer += data
      if (match.test(buffer)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })
}

function open(command?: string): PtySession {
  const session = new PtySession(adapter, {
    tmuxSession: NAME,
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
    command,
  })
  session.start()
  return session
}

beforeAll(killServer)
afterEach(killServer)

describe('PtySession', () => {
  it('creates the tmux session on start', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    await expect(adapter.hasSession(NAME)).resolves.toBe(true)
    session.detach()
  })

  it('runs input and streams output back', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    session.write('echo prcli-marker\r')
    const output = await waitForOutput(session, /prcli-marker/)
    expect(output).toContain('prcli-marker')
    session.detach()
  })

  it('leaves the tmux session running after detach', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    const exited = new Promise<void>((resolve) => session.onExit(() => resolve()))
    session.detach()
    await exited
    await expect(adapter.hasSession(NAME)).resolves.toBe(true)
  })

  it('reattaches to an existing session and keeps its scrollback', async () => {
    const first = open()
    await waitForOutput(first, /\$|%|#/)
    first.write('echo remembered-value\r')
    await waitForOutput(first, /remembered-value/)
    const exited = new Promise<void>((resolve) => first.onExit(() => resolve()))
    first.detach()
    await exited

    const second = open()
    const output = await waitForOutput(second, /remembered-value/)
    expect(output).toContain('remembered-value')
    second.detach()
  })

  it('runs an explicit command when one is given', async () => {
    const session = open('echo command-ran; sleep 30')
    const output = await waitForOutput(session, /command-ran/)
    expect(output).toContain('command-ran')
    session.detach()
  })

  it('exposes 24-bit colour support to the child process', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    session.write('echo "TERM=$TERM COLORTERM=$COLORTERM"\r')
    const output = await waitForOutput(session, /COLORTERM=truecolor/)
    expect(output).toMatch(/TERM=(screen|tmux)-256color/)
    session.detach()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/session.test.ts`
Expected: FAIL — cannot resolve `../../src/main/pty/session`.

- [ ] **Step 3: Implement**

Create `src/main/pty/session.ts`:

```ts
import { spawn, type IPty } from 'node-pty'
import type { TmuxAdapter } from '../tmux/adapter'

export interface PtySessionOptions {
  tmuxSession: string
  cwd: string
  cols: number
  rows: number
  /** Command to run when the session is created. Ignored when reattaching. */
  command?: string
  env?: NodeJS.ProcessEnv
}

/**
 * A single attached tmux client, exposed as a PTY.
 *
 * The lifetime of this object is the lifetime of the *client*, not the tmux
 * session. Disposing it detaches; the session and everything running inside
 * it keep going. Killing the session is TmuxAdapter's job.
 */
export class PtySession {
  readonly tmuxSession: string

  private proc: IPty | null = null
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(
    private readonly adapter: TmuxAdapter,
    private readonly options: PtySessionOptions,
  ) {
    this.tmuxSession = options.tmuxSession
  }

  start(): void {
    if (this.proc) throw new Error(`PtySession ${this.tmuxSession} already started`)

    // `new-session -A` attaches if the session exists and creates it otherwise,
    // which is exactly the open-or-adopt behaviour we want in one call.
    const args = [
      ...this.adapter.baseArgs(),
      'new-session',
      '-A',
      '-s',
      this.options.tmuxSession,
      '-c',
      this.options.cwd,
    ]
    if (this.options.command) args.push(this.options.command)

    const env = { ...process.env, ...this.options.env }
    // Electron sets this when re-execing as Node; leaking it breaks child shells.
    delete env.ELECTRON_RUN_AS_NODE
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    this.proc = spawn(this.adapter.bin, args, {
      name: 'xterm-256color',
      cols: this.options.cols,
      rows: this.options.rows,
      cwd: this.options.cwd,
      env: env as Record<string, string>,
    })

    this.proc.onData((data) => {
      for (const listener of this.dataListeners) listener(data)
    })
    this.proc.onExit(({ exitCode }) => {
      this.proc = null
      for (const listener of this.exitListeners) listener(exitCode)
    })
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return
    this.proc?.resize(cols, rows)
  }

  /** Detach the client. The tmux session survives. */
  detach(): void {
    this.proc?.kill()
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.add(listener)
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.add(listener)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/session.test.ts`
Expected: PASS, 6 tests.

If the first test times out waiting for a prompt, the shell is probably printing something unexpected — run `tmux -L prcli-test new-session -A -s debug` by hand to see what a fresh session looks like, and widen the prompt regex.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty/session.ts tests/integration/session.test.ts
git commit -m "$(cat <<'EOF'
Add PtySession

Attaches to a tmux session through node-pty using new-session -A, so the
same call creates or adopts. Disposing detaches the client and leaves the
session running.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: SessionManager

The registry the rest of the app talks to. Owns open/adopt/detach/kill.

**Files:**
- Create: `src/main/sessions/manager.ts`
- Test: `tests/integration/manager.test.ts`

**Interfaces:**
- Consumes: `TmuxAdapter` (Task 3), `PtySession` (Task 4), `encodeSessionName`/`decodeSessionName`/`newSessionId` (Task 2)
- Produces:
  - `interface TabRecord { id: string; projectSlug: string; cwd: string; command?: string; tmuxSession: string }`
  - `class SessionManager { constructor(adapter: TmuxAdapter); open(input: { projectSlug: string; cwd: string; command?: string; id?: string; cols?: number; rows?: number }): TabRecord; get(id: string): TabRecord | undefined; list(): TabRecord[]; write(id: string, data: string): void; resize(id: string, cols: number, rows: number): void; detach(id: string): void; detachAll(): void; kill(id: string): Promise<void>; findOrphans(): Promise<TabRecord[]>; onData(listener: (id: string, data: string) => void): void; onExit(listener: (id: string, code: number) => void): void }`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/manager.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'

const run = promisify(execFile)
const SOCKET = 'prcli-test'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

function waitFor(
  manager: SessionManager,
  id: string,
  match: RegExp,
  ms = 8000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${match}; saw: ${JSON.stringify(buffer)}`)),
      ms,
    )
    manager.onData((emittedId, data) => {
      if (emittedId !== id) return
      buffer += data
      if (match.test(buffer)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })
}

beforeAll(killServer)
afterEach(killServer)

describe('SessionManager.open', () => {
  it('returns a record with a generated id and encoded tmux name', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    expect(tab.id).toMatch(/^[0-9a-f]{16}$/)
    expect(tab.tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detachAll()
  })

  it('reuses a supplied id so a tab can be reattached', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), id: 'a1b2c3d4e5f60718' })
    expect(tab.tmuxSession).toBe('prcli-lumio-a1b2c3d4e5f60718')
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detachAll()
  })

  it('rejects opening the same id twice', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    expect(() => manager.open({ projectSlug: 'lumio', cwd: tmpdir(), id: tab.id }))
      .toThrow(/already open/i)
    manager.detachAll()
  })
})

describe('SessionManager.write', () => {
  it('routes input to the right session', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.write(tab.id, 'echo routed-ok\r')
    await expect(waitFor(manager, tab.id, /routed-ok/)).resolves.toContain('routed-ok')
    manager.detachAll()
  })
})

describe('SessionManager.detach', () => {
  it('removes the tab from the registry but keeps the tmux session', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detach(tab.id)
    expect(manager.get(tab.id)).toBeUndefined()
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
  })
})

describe('SessionManager.kill', () => {
  it('destroys the tmux session', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    await manager.kill(tab.id)
    expect(manager.get(tab.id)).toBeUndefined()
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(false)
  })
})

describe('SessionManager.findOrphans', () => {
  it('reports prcli sessions that are not currently open', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const tab = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, tab.id, /\$|%|#/)
    first.detachAll()

    const second = new SessionManager(adapter)
    const orphans = await second.findOrphans()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({
      id: tab.id,
      projectSlug: 'lumio',
      tmuxSession: tab.tmuxSession,
    })
  })

  it('ignores sessions that are already open', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    await expect(manager.findOrphans()).resolves.toEqual([])
    manager.detachAll()
  })

  it('ignores foreign tmux sessions', async () => {
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'not-ours', 'sleep', '600'])
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    await expect(manager.findOrphans()).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/manager.test.ts`
Expected: FAIL — cannot resolve `../../src/main/sessions/manager`.

- [ ] **Step 3: Implement**

Create `src/main/sessions/manager.ts`:

```ts
import type { TmuxAdapter } from '../tmux/adapter'
import { PtySession } from '../pty/session'
import { decodeSessionName, encodeSessionName, newSessionId } from '../tmux/names'

export interface TabRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
}

export interface OpenInput {
  projectSlug: string
  cwd: string
  command?: string
  /** Supply to reattach an existing tab; omit to create a new one. */
  id?: string
  cols?: number
  rows?: number
}

interface Entry {
  record: TabRecord
  session: PtySession
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export class SessionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly dataListeners = new Set<(id: string, data: string) => void>()
  private readonly exitListeners = new Set<(id: string, code: number) => void>()

  constructor(private readonly adapter: TmuxAdapter) {}

  open(input: OpenInput): TabRecord {
    const id = input.id ?? newSessionId()
    if (this.entries.has(id)) throw new Error(`session ${id} is already open`)

    const record: TabRecord = {
      id,
      projectSlug: input.projectSlug,
      cwd: input.cwd,
      command: input.command,
      tmuxSession: encodeSessionName({ projectSlug: input.projectSlug, id }),
    }

    const session = new PtySession(this.adapter, {
      tmuxSession: record.tmuxSession,
      cwd: record.cwd,
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      command: record.command,
    })

    session.onData((data) => {
      for (const listener of this.dataListeners) listener(id, data)
    })
    session.onExit((code) => {
      this.entries.delete(id)
      for (const listener of this.exitListeners) listener(id, code)
    })

    this.entries.set(id, { record, session })
    session.start()
    return record
  }

  get(id: string): TabRecord | undefined {
    return this.entries.get(id)?.record
  }

  list(): TabRecord[] {
    return [...this.entries.values()].map((entry) => entry.record)
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.session.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.entries.get(id)?.session.resize(cols, rows)
  }

  /** Detach the client. The tmux session keeps running. */
  detach(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.session.detach()
  }

  detachAll(): void {
    for (const id of [...this.entries.keys()]) this.detach(id)
  }

  /** Destroy the tmux session and everything running in it. */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    const tmuxSession = entry?.record.tmuxSession ?? undefined
    if (entry) {
      this.entries.delete(id)
      entry.session.detach()
    }
    if (tmuxSession) await this.adapter.killSession(tmuxSession)
  }

  /**
   * prcli-owned tmux sessions with no client in this app — left behind by a
   * previous run or a crash. Callers decide whether to reopen them.
   */
  async findOrphans(): Promise<TabRecord[]> {
    const open = new Set(this.list().map((record) => record.tmuxSession))
    const names = await this.adapter.listPrcliSessions()
    const orphans: TabRecord[] = []
    for (const name of names) {
      if (open.has(name)) continue
      const parts = decodeSessionName(name)
      if (!parts) continue
      orphans.push({
        id: parts.id,
        projectSlug: parts.projectSlug,
        // The session already has its own working directory; reattaching
        // does not change it, so any valid path serves here.
        cwd: process.env.HOME ?? '/',
        tmuxSession: name,
      })
    }
    return orphans
  }

  onData(listener: (id: string, data: string) => void): void {
    this.dataListeners.add(listener)
  }

  onExit(listener: (id: string, code: number) => void): void {
    this.exitListeners.add(listener)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/manager.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/manager.ts tests/integration/manager.test.ts
git commit -m "$(cat <<'EOF'
Add SessionManager

Registry of open sessions with open, detach, kill and orphan discovery.
Detach removes the tab but leaves tmux running; kill destroys it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Config store

Persists which sessions were open so the next launch can reattach them.

**Files:**
- Create: `src/main/state/store.ts`
- Test: `tests/unit/store.test.ts`

**Interfaces:**
- Consumes: `TabRecord` from Task 5
- Produces:
  - `interface PrcliConfig { version: 1; tabs: TabRecord[] }`
  - `class ConfigStore { constructor(filePath: string); read(): Promise<PrcliConfig>; write(config: PrcliConfig): Promise<void>; static defaultPath(): string }`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, type PrcliConfig } from '../../src/main/state/store'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-store-'))
  file = join(dir, 'config.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sampleConfig: PrcliConfig = {
  version: 1,
  tabs: [
    {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
    },
  ],
}

describe('ConfigStore.read', () => {
  it('returns an empty config when the file does not exist', async () => {
    await expect(new ConfigStore(file).read()).resolves.toEqual({ version: 1, tabs: [] })
  })

  it('returns an empty config when the file is corrupt', async () => {
    await writeFile(file, '{not json', 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({ version: 1, tabs: [] })
  })

  it('returns an empty config when the shape is wrong', async () => {
    await writeFile(file, JSON.stringify({ version: 1, tabs: 'nope' }), 'utf8')
    await expect(new ConfigStore(file).read()).resolves.toEqual({ version: 1, tabs: [] })
  })
})

describe('ConfigStore.write', () => {
  it('round-trips a config', async () => {
    const store = new ConfigStore(file)
    await store.write(sampleConfig)
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })

  it('creates the parent directory', async () => {
    const nested = join(dir, 'deep', 'config.json')
    await new ConfigStore(nested).write(sampleConfig)
    await expect(readFile(nested, 'utf8')).resolves.toContain('lumio')
  })

  it('writes atomically, leaving no temp file behind', async () => {
    await new ConfigStore(file).write(sampleConfig)
    await expect(readdir(dir)).resolves.toEqual(['config.json'])
  })

  it('does not corrupt the existing file when given unserialisable input', async () => {
    const store = new ConfigStore(file)
    await store.write(sampleConfig)
    const circular = { version: 1, tabs: [] } as unknown as PrcliConfig
    ;(circular as unknown as { self: unknown }).self = circular
    await expect(store.write(circular)).rejects.toThrow()
    await expect(store.read()).resolves.toEqual(sampleConfig)
  })
})

describe('ConfigStore.defaultPath', () => {
  it('points at ~/.prcli/config.json', () => {
    expect(ConfigStore.defaultPath()).toMatch(/\.prcli\/config\.json$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: FAIL — cannot resolve `../../src/main/state/store`.

- [ ] **Step 3: Implement**

Create `src/main/state/store.ts`:

```ts
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TabRecord } from '../sessions/manager'

export interface PrcliConfig {
  version: 1
  tabs: TabRecord[]
}

const EMPTY: PrcliConfig = { version: 1, tabs: [] }

function isValid(value: unknown): value is PrcliConfig {
  if (typeof value !== 'object' || value === null) return false
  const config = value as Partial<PrcliConfig>
  return config.version === 1 && Array.isArray(config.tabs)
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(): string {
    return join(homedir(), '.prcli', 'config.json')
  }

  /**
   * Never throws. A missing or damaged config must not stop the app from
   * starting — the worst case is losing layout, which the user can rebuild.
   */
  async read(): Promise<PrcliConfig> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return isValid(parsed) ? parsed : { ...EMPTY }
    } catch {
      return { ...EMPTY }
    }
  }

  /** Serialise first, then write to a temp file and rename over the target. */
  async write(config: PrcliConfig): Promise<void> {
    const json = JSON.stringify(config, null, 2)
    await mkdir(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      await writeFile(temp, json, 'utf8')
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: PASS, 8 tests. The unserialisable-input test passes because `JSON.stringify` throws before any file is touched.

- [ ] **Step 5: Commit**

```bash
git add src/main/state/store.ts tests/unit/store.test.ts
git commit -m "$(cat <<'EOF'
Add ConfigStore

Atomic writes via temp file and rename. Reads never throw so a damaged
config costs layout, not startup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: IPC contract and preload bridge

Wires `SessionManager` to the renderer. No new logic — a typed transport.

**Files:**
- Create: `src/shared/ipc.ts`, `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts` (replace contents), `src/main/index.ts`

**Interfaces:**
- Consumes: `SessionManager`, `TabRecord` (Task 5), `TmuxAdapter` (Task 3), `ConfigStore` (Task 6)
- Produces:
  - `src/shared/ipc.ts`: `CHANNELS` constant, `OpenRequest`, `DataEvent`, `ExitEvent`, `PrcliApi` types
  - `registerIpc(manager: SessionManager, getWindow: () => BrowserWindow | null, store?: ConfigStore): void`
  - `window.prcli` in the renderer, typed as `PrcliApi`

- [ ] **Step 1: Define the shared contract**

Create `src/shared/ipc.ts`:

```ts
export const CHANNELS = {
  open: 'prcli:open',
  list: 'prcli:list',
  input: 'prcli:input',
  resize: 'prcli:resize',
  detach: 'prcli:detach',
  kill: 'prcli:kill',
  restore: 'prcli:restore',
  data: 'prcli:data',
  exit: 'prcli:exit',
} as const

export interface TabDescriptor {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
}

export interface OpenRequest {
  projectSlug: string
  cwd: string
  command?: string
  id?: string
  cols?: number
  rows?: number
}

export interface DataEvent {
  id: string
  data: string
}

export interface ExitEvent {
  id: string
  code: number
}

export interface PrcliApi {
  open(request: OpenRequest): Promise<TabDescriptor>
  list(): Promise<TabDescriptor[]>
  /** Reattach tabs persisted by the previous run; returns what came back. */
  restore(): Promise<TabDescriptor[]>
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  detach(id: string): void
  kill(id: string): Promise<void>
  onData(listener: (event: DataEvent) => void): () => void
  onExit(listener: (event: ExitEvent) => void): () => void
}
```

- [ ] **Step 2: Implement the main-side registration**

Create `src/main/ipc/register.ts`:

```ts
import { ipcMain, type BrowserWindow } from 'electron'
import { CHANNELS, type OpenRequest, type TabDescriptor } from '../../shared/ipc'
import type { SessionManager } from '../sessions/manager'
import { ConfigStore } from '../state/store'

export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
): void {
  const persist = async (): Promise<void> => {
    await store.write({ version: 1, tabs: manager.list() })
  }

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  manager.onData((id, data) => send(CHANNELS.data, { id, data }))
  manager.onExit((id, code) => {
    send(CHANNELS.exit, { id, code })
    void persist()
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    const record = manager.open(request)
    await persist()
    return record
  })

  ipcMain.handle(CHANNELS.list, (): TabDescriptor[] => manager.list())

  ipcMain.handle(CHANNELS.restore, async (): Promise<TabDescriptor[]> => {
    const saved = await store.read()
    const orphans = await manager.findOrphans()
    const alive = new Set(orphans.map((orphan) => orphan.tmuxSession))
    const restored: TabDescriptor[] = []
    for (const tab of saved.tabs) {
      // Only reattach tabs whose tmux session actually still exists.
      if (!alive.has(tab.tmuxSession)) continue
      restored.push(
        manager.open({
          id: tab.id,
          projectSlug: tab.projectSlug,
          cwd: tab.cwd,
          command: tab.command,
        }),
      )
    }
    await persist()
    return restored
  })

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows),
  )

  ipcMain.on(CHANNELS.detach, (_event, id: string) => {
    manager.detach(id)
    void persist()
  })

  ipcMain.handle(CHANNELS.kill, async (_event, id: string) => {
    await manager.kill(id)
    await persist()
  })
}
```

- [ ] **Step 3: Implement the preload bridge**

Replace the entire contents of `src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  type DataEvent,
  type ExitEvent,
  type OpenRequest,
  type PrcliApi,
  type TabDescriptor,
} from '../shared/ipc'

const api: PrcliApi = {
  open: (request: OpenRequest) => ipcRenderer.invoke(CHANNELS.open, request),
  list: () => ipcRenderer.invoke(CHANNELS.list),
  restore: () => ipcRenderer.invoke(CHANNELS.restore),
  input: (id, data) => ipcRenderer.send(CHANNELS.input, id, data),
  resize: (id, cols, rows) => ipcRenderer.send(CHANNELS.resize, id, cols, rows),
  detach: (id) => ipcRenderer.send(CHANNELS.detach, id),
  kill: (id) => ipcRenderer.invoke(CHANNELS.kill, id),
  onData: (listener: (event: DataEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: DataEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.data, handler)
    return () => ipcRenderer.removeListener(CHANNELS.data, handler)
  },
  onExit: (listener: (event: ExitEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: ExitEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.exit, handler)
    return () => ipcRenderer.removeListener(CHANNELS.exit, handler)
  },
}

contextBridge.exposeInMainWorld('prcli', api)

export type { TabDescriptor }
```

- [ ] **Step 4: Wire it up in main**

Replace `src/main/index.ts` entirely. Keep the Forge-injected constants — they are declared globals from the Vite plugin:

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from './tmux/adapter'
import { SessionManager } from './sessions/manager'
import { registerIpc } from './ipc/register'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null

const adapter = new TmuxAdapter()
const manager = new SessionManager(adapter)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#09090b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  try {
    await adapter.version()
  } catch (error) {
    if (error instanceof TmuxNotInstalledError) {
      // Milestone 4 replaces this with an onboarding screen.
      console.error('tmux is required. Install it with: brew install tmux')
      app.exit(1)
      return
    }
    throw error
  }

  registerIpc(manager, () => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Detach every client on quit. tmux sessions keep running by design.
app.on('before-quit', () => manager.detachAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 5: Verify it compiles and the app still boots**

```bash
npm run typecheck
npm start
```

Expected: typecheck clean; window opens showing `PRCLI`; no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/register.ts src/preload/index.ts src/main/index.ts
git commit -m "$(cat <<'EOF'
Add typed IPC contract and preload bridge

Exposes session open/input/resize/detach/kill and data/exit streams to the
renderer through contextBridge. Open tabs persist to config on every change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Terminal view and end-to-end verification

The milestone deliverable: a visible, working terminal that survives relaunch.

**Files:**
- Create: `src/renderer/Terminal.tsx`, `src/renderer/global.d.ts`, `playwright.config.ts`, `tests/e2e/launch.spec.ts`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `window.prcli` (Task 7)
- Produces: `<Terminal tabId="…" />`, a mounted xterm bound to one session

- [ ] **Step 1: Declare the window global**

Create `src/renderer/global.d.ts`:

```ts
import type { PrcliApi } from '../shared/ipc'

declare global {
  interface Window {
    prcli: PrcliApi
  }
}

export {}
```

- [ ] **Step 2: Implement the terminal component**

Create `src/renderer/Terminal.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function Terminal({ tabId }: { tabId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      allowProposedApi: true,
      // Bounded per-pane so twelve live panes cannot grow without limit.
      // tmux keeps the deeper history.
      scrollback: 5000,
      theme: { background: '#09090b', foreground: '#d4d4d8' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    const offData = window.prcli.onData(({ id, data }) => {
      if (id === tabId) term.write(data)
    })
    const inputDisposable = term.onData((data) => window.prcli.input(tabId, data))

    // Tell the PTY our real size once xterm has measured itself.
    window.prcli.resize(tabId, term.cols, term.rows)

    const observer = new ResizeObserver(() => {
      fit.fit()
      window.prcli.resize(tabId, term.cols, term.rows)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      offData()
      term.dispose()
    }
  }, [tabId])

  return <div data-testid="terminal" ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
```

- [ ] **Step 3: Restore or create a session on mount**

Replace `src/renderer/App.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Terminal } from './Terminal'

export function App() {
  const [tabId, setTabId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const restored = await window.prcli.restore()
      if (cancelled) return
      if (restored.length > 0) {
        setTabId(restored[0].id)
        return
      }
      const tab = await window.prcli.open({
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
      })
      if (!cancelled) setTabId(tab.id)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#09090b', padding: 8 }}>
      {tabId ? <Terminal tabId={tabId} /> : null}
    </div>
  )
}
```

- [ ] **Step 4: Verify by hand that a real Claude session renders**

```bash
npm start
```

In the terminal that appears, type:

```
cd /Users/paolo/Code/PRCLI && claude
```

Check all of the following, since automated tests cannot judge them:
- Colours render, including 24-bit gradients in Claude's output
- The status line at the bottom is not garbled
- Resizing the window reflows Claude's TUI without corruption
- ⇧Tab cycles permission modes
- Mouse scrolling moves the scrollback

- [ ] **Step 5: Write the end-to-end test**

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  // Electron launches one app instance per worker; serial keeps tmux state sane.
  workers: 1,
  fullyParallel: false,
})
```

Create `tests/e2e/launch.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

let userDataDir: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
  })
}

/** Kill every prcli session this test created, on the default tmux socket. */
async function cleanupSessions(): Promise<void> {
  let stdout = ''
  try {
    ;({ stdout } = await run('tmux', ['list-sessions', '-F', '#{session_name}']))
  } catch {
    return
  }
  for (const name of stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (name.startsWith('prcli-scratch-')) {
      await run('tmux', ['kill-session', '-t', `=${name}`]).catch(() => undefined)
    }
  }
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-'))
})

test.afterEach(async () => {
  await cleanupSessions()
  await rm(userDataDir, { recursive: true, force: true })
})

test('renders a terminal and echoes typed input', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  const terminal = window.getByTestId('terminal')
  await expect(terminal).toBeVisible()

  // Click first so xterm's hidden textarea has focus before typing.
  await terminal.click()
  await window.keyboard.type('echo e2e-marker')
  await window.keyboard.press('Enter')

  await expect(window.locator('.xterm-rows')).toContainText('e2e-marker', { timeout: 20_000 })
  await app.close()
})

test('reattaches the same session with scrollback after relaunch', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal')).toBeVisible()
  await firstWindow.getByTestId('terminal').click()
  await firstWindow.keyboard.type('echo survives-restart')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.locator('.xterm-rows')).toContainText('survives-restart', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('.xterm-rows')).toContainText('survives-restart', {
    timeout: 20_000,
  })
  await second.close()
})
```

Note: the E2E test uses a fresh `--user-data-dir` per test but the real `~/.prcli/config.json`, because `ConfigStore.defaultPath()` is home-relative. The relaunch test depends on that shared config — that is why `cleanupSessions` runs afterwards.

- [ ] **Step 6: Run the end-to-end tests**

```bash
npm run e2e
```

Expected: both tests pass. The first run is slow because `npm run package` builds the app.

- [ ] **Step 7: Run the whole suite**

```bash
npm test && npm run typecheck && npm run e2e
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/renderer tests/e2e playwright.config.ts
git commit -m "$(cat <<'EOF'
Add xterm terminal view and end-to-end tests

Renderer mounts one xterm bound to a session id, restoring the previous
run's tmux session when one survives. E2E covers echo and reattach.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 1 done when

- `npm start` opens a window with a working terminal
- Claude Code runs inside it and renders correctly (Task 8 Step 4 checklist)
- Quitting and relaunching reattaches the same tmux session with scrollback
- `npm test`, `npm run typecheck` and `npm run e2e` are all green
- `tmux ls` shows a surviving `prcli-scratch-<id>` session after the app quits

## Not in this milestone

Projects, sidebar, tab bar, splits, skills panel, presets, hook bridge, state machine, notifications, dock badge, settings, onboarding. Milestone 2 (`Workspace`) is planned after this one lands.
