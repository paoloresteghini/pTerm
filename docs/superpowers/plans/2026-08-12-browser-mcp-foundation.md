# Browser MCP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude session running in a PRCLI pane can navigate a browser pane of its own, confined to loopback, with every call visible in that pane.

**Architecture:** A stdio MCP bridge, spawned per session by Claude Code and registered once in `~/.claude.json`, forwards requests over a unix socket to the running app. Main routes each request by the `PTERM_TAB_ID` the session already carries, creates the session's browser pane on demand, and drives it through a CDP `debugger` attach. Confinement is enforced on the pane's `webContents`, not inside the navigate tool.

**Tech Stack:** Electron 38, React 19, TypeScript, node:net unix sockets, Chrome DevTools Protocol via `webContents.debugger`, vitest (node environment), Playwright (Electron).

**Spec:** `docs/superpowers/specs/2026-08-12-browser-mcp-design.md` (commit 72957e8).

**Scope:** This plan delivers the whole path end to end with ONE tool, `browser_navigate`. The remaining six tools (`browser_read_page`, `browser_find`, `browser_computer`, `browser_form_input`, `browser_console`, `browser_network`) are a second plan that adds handlers to a proven transport. At the end of this plan the feature is usable and testable on its own: an agent can open a page in its own pane and be refused a non-loopback one.

## Global Constraints

- **No em dashes anywhere.** Not in code, comments, test names, or commit messages. Use commas, colons, parentheses, or separate sentences. Hyphens in compound words are fine.
- **Comments must be true of the branch, not just of the commit that writes them.** If a later task changes behaviour an earlier comment describes, fixing that comment is part of the later task.
- **Do not prescribe comment text from this plan.** Where a comment appears below it is showing intent. Write what is true when you get there, and measure any number before stating it. A qualifier over a ratio ("most", "nearly all") is a measurement too.
- **Verification is by running, not by reading.** Every step claiming a test fails or passes names the command and the expected output.
- **`vitest.config.mts` runs `environment: 'node'`.** No DOM in unit tests. Anything needing layout or React goes in a Playwright spec.
- **Never write to the user's real `~/.claude.json` from a test.** The hooks subsystem already solves this: `claudeSettingsPath()` honours `PTERM_CLAUDE_SETTINGS`, and `hookPaths()` honours `PTERM_CONFIG_DIR`. The new paths must honour the same overrides, and a test that writes an unguarded home path is a defect even if it passes.
- Commands: `npm test`, `npm run typecheck`, `npx vitest run tests/unit/<file>`, `npx playwright test tests/e2e/<file>`.
- Before any Playwright run: `tmux -L pterm-test kill-server 2>/dev/null || true`.
- Keep any single command under about two minutes, except a full `npm run e2e` (about four), which should be the only command in its turn.

## Measured Ground Truth

These were checked against this machine on 2026-08-12. Re-check rather than trust them if something does not line up.

- MCP servers are registered in **`~/.claude.json`**, at the ROOT key `mcpServers`. This is a different file from `~/.claude/settings.json`, which is where the hooks live. It also holds per-project entries under `projects[<cwd>].mcpServers`, which this plan does not touch.
- The entry schema for a stdio server is `{"type": "stdio", "command": string, "args": string[], "env": Record<string, string>}`.
- That file was 195KB and holds a great deal of unrelated state (startup counts, per-project history, cached feature flags). It must be read, modified and written back preserving everything else, with a backup first.
- Every session's tmux environment carries `PTERM_TAB_ID` (`src/main/sessions/manager.ts`), which is the pane id.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/shared/localOrigin.ts` | The one predicate deciding whether a URL is loopback |
| `src/main/mcp/protocol.ts` | The request/response line format between bridge and app |
| `src/main/mcp/server.ts` | The unix socket server: accepts, parses, dispatches, replies |
| `src/main/mcp/install.ts` | Registering and removing the bridge in `~/.claude.json` |
| `src/main/mcp/bridge.ts` | The stdio MCP server that Claude Code spawns |
| `src/main/mcp/route.ts` | Pane id to project to the session's browser pane, creating it on demand |
| `src/renderer/AgentStrip.tsx` | The last-call strip drawn in an agent-owned pane |
| `tests/unit/localOrigin.test.ts`, `tests/unit/mcpProtocol.test.ts`, `tests/unit/mcpInstall.test.ts`, `tests/unit/mcpRoute.test.ts` | Unit coverage for each of the above |
| `tests/integration/mcpServer.test.ts` | The socket server driven by a raw client, no app around it |
| `tests/e2e/browserMcp.spec.ts` | The strip, the pane creation, and the confinement refusal |

**Modified:**

| File | Change |
| --- | --- |
| `src/shared/ipc.ts` | `agentSessionId` on `TabDescriptor`; the IPC channel carrying tool events to the renderer |
| `src/main/state/store.ts` | Persisting nothing new: the agent flag is deliberately runtime only (see Task 6) |
| `src/main/ipc/register.ts` | Starting and stopping the MCP server with the app |
| `src/renderer/BrowserPane.tsx` | Rendering `AgentStrip` when the pane is agent owned |
| `src/main/index.ts` | Installing the bridge on launch, beside the hook install |

---

### Task 1: The loopback predicate

**Files:**
- Create: `src/shared/localOrigin.ts`
- Create: `tests/unit/localOrigin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isLoopbackUrl(raw: string): boolean`

This is first because it is the security boundary, and everything downstream cites it.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { isLoopbackUrl } from '../../src/shared/localOrigin'

describe('isLoopbackUrl', () => {
  it('accepts the loopback hosts on any port', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://localhost/',
      'https://localhost:8443/x?y=1',
      'http://127.0.0.1:3000/',
      'http://[::1]:3000/',
      'http://app.localhost:5173/',
    ]) {
      expect(isLoopbackUrl(url)).toBe(true)
    }
  })

  it('refuses everything else', () => {
    for (const url of [
      'https://github.com/',
      'http://192.168.1.10:5173/',
      'http://10.0.0.1/',
      'http://example.com/',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })

  // The interesting half. Each of these has been used to slip a non-loopback
  // host past a naive string check, so each is a case the predicate must
  // answer on the parsed URL rather than on the text.
  it('refuses hosts that merely look loopback', () => {
    for (const url of [
      'http://localhost.evil.com/',
      'http://notlocalhost/',
      'http://127.0.0.1.evil.com/',
      'https://user:pass@evil.com/?x=localhost',
      'http://evil.com#localhost',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })

  // Non-http schemes are not "a page on your dev server" and several of them
  // reach outside the browser entirely.
  it('refuses non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'about:blank',
      'chrome://settings',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })

  it('refuses input it cannot parse', () => {
    for (const url of ['', 'not a url', '://', 'http://']) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/localOrigin.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Parse with `new URL(raw)` inside a try/catch, refuse on throw. Accept only `http:` and `https:` protocols. Then compare `url.hostname` against `localhost`, `127.0.0.1`, the IPv6 loopback, and any hostname ending in `.localhost`.

Measure the IPv6 spelling rather than assuming it. This plan originally asserted that `URL` normalises `::1` out of its brackets, and that is FALSE: measured on 2026-08-12, `new URL('http://[::1]:3000/').hostname` is `'[::1]'`, brackets included, and `.host` is `'[::1]:3000'`. Compare against the bracketed form.

Two traps to handle deliberately rather than incidentally: `hostname` excludes the port and any credentials, which is why the check reads it rather than `host` or the raw string; and `127.0.0.1.evil.com` ends in neither, so an `endsWith('localhost')` without the dot would pass `notlocalhost`.

- [ ] **Step 4: Run and confirm**

Run: `npx vitest run tests/unit/localOrigin.test.ts && npm run typecheck`
Expected: all green, tsc silent.

- [ ] **Step 5: Sabotage check, recorded**

Change the hostname comparison to `url.hostname.includes('localhost')` and run the tests. Confirm the "merely look loopback" case goes red, and record the observed failure. Restore. A predicate whose test suite passes under a substring check is not testing the thing that matters.

- [ ] **Step 6: Commit**

```bash
git add src/shared/localOrigin.ts tests/unit/localOrigin.test.ts
git commit -m "Add the loopback predicate the browser tools are confined to"
```

---

### Task 2: The bridge protocol

**Files:**
- Create: `src/main/mcp/protocol.ts`
- Create: `tests/unit/mcpProtocol.test.ts`

**Interfaces:**
- Produces:
  - `export interface McpRequest { id: number; paneId: string; tool: string; args: Record<string, unknown> }`
  - `export interface McpResponse { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }`
  - `export function parseRequestLine(line: string): McpRequest | null`
  - `export function formatResponseLine(response: McpResponse): string`
  - `export const MAX_LINE_BYTES: number`

Read `src/main/hooks/protocol.ts` first and follow it. The difference to keep in mind: hook lines are one way and fire and forget, so a malformed one is dropped. These are request and response, so a malformed request still needs an answer carrying the id, or the bridge waits forever.

- [ ] **Step 1: Write the failing tests**

Cover: a well-formed request round trips; a line that is not JSON returns null; JSON that is not an object returns null; a request missing `id`, `paneId` or `tool` returns null; `args` absent defaults to `{}`; a line over `MAX_LINE_BYTES` returns null; and a response containing a newline in its error string is escaped so it cannot forge a second line.

That last one is the case worth writing first, because it is the one that turns a bad error message into a protocol break.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/mcpProtocol.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement, then run**

Newline-delimited JSON, one object per line, `JSON.stringify` for the response (which escapes newlines by construction, so the escaping test passes without special code, and the test exists to keep it that way).

Pick `MAX_LINE_BYTES` larger than the hooks' 512: a `browser_navigate` URL is bigger than a hook event, and a later plan sends accessibility trees back. Set the REQUEST cap deliberately and state your reasoning in the code; responses are generated by us and are not parsed by this module.

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp/protocol.ts tests/unit/mcpProtocol.test.ts
git commit -m "Add the request and response protocol for the browser bridge"
```

---

### Task 3: The socket server

**Files:**
- Create: `src/main/mcp/server.ts`
- Create: `tests/integration/mcpServer.test.ts`

**Interfaces:**
- Consumes: Task 2's protocol.
- Produces: `export class McpServer` with `listen(path: string)`, `close()`, and a constructor taking a handler `(request: McpRequest) => Promise<unknown>` whose rejection becomes an `ok: false` response.

Read `src/main/hooks/server.ts` closely and inherit its constraints rather than rediscovering them. Its comments record measurements, not guesses: the 104-byte `sun_path` ceiling measured against this kernel, the connect-probe that tells a stale socket file from a live second process, and the buffer cap that stops a client which never sends a newline from growing memory without bound. All four apply here unchanged.

- [ ] **Step 1: Write the failing integration test**

Drive it with a raw `net.connect` client, no app around it, exactly as the hook server's tests do. Cover: a request gets a response with the same id; two requests on one connection get two responses; a handler that throws produces `ok: false` with the message and does not kill the connection; a malformed line produces an error response rather than silence when an id can be recovered, and is dropped when it cannot; and a socket path over the ceiling fails with a clear error rather than a bare `EINVAL`.

- [ ] **Step 2: Run, implement, run**

Run: `npx vitest run tests/integration/mcpServer.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/server.ts tests/integration/mcpServer.test.ts
git commit -m "Serve browser tool requests on a unix socket"
```

---

### Task 4: Routing a request to a pane

**Files:**
- Create: `src/main/mcp/route.ts`
- Create: `tests/unit/mcpRoute.test.ts`
- Modify: `src/shared/ipc.ts` (`TabDescriptor` gains `agentSessionId?: string`)

**Interfaces:**
- Produces: `export function browserPaneFor(config, paneId): { paneId: string } | { create: { projectSlug: string; cwd: string } } | { error: string }`

The rule: the calling pane id names a session; that session's project is found by its `projectSlug`; the browser pane belonging to that SESSION is the one whose `agentSessionId` equals the calling pane id. If none exists, the caller is told to create one.

- [ ] **Step 1: Write the failing tests**

Cover: an unknown pane id is an error naming what was not found; a session with no agent browser pane asks for creation with the right project slug and cwd; a session that already has one returns it; a project with several agent panes owned by DIFFERENT sessions returns only the caller's; and a browser pane with no `agentSessionId` (one the user opened by hand) is never returned.

That last case is the one that protects the decision you made in brainstorming: the agent drives its own pane, never the user's.

- [ ] **Step 2: Run, implement, run.** Then commit.

```bash
git add src/shared/ipc.ts src/main/mcp/route.ts tests/unit/mcpRoute.test.ts
git commit -m "Route a tool request to the calling session's own browser pane"
```

---

### Task 5: Installing the bridge in the user's Claude config

**Files:**
- Create: `src/main/mcp/install.ts`
- Create: `tests/unit/mcpInstall.test.ts`

**Interfaces:**
- Produces: `mcpConfigPath()`, `bridgePaths()`, `mergeMcpServer(config, entry)`, `unmergeMcpServer(config)`, `isMcpInstalled(config)`, `installMcpBridge()`, `uninstallMcpBridge()`

Model every one of these on `src/main/hooks/install.ts`, which solves the same problem for a different file and has already absorbed a rename migration, a backup path, and a shape it refuses to touch when it does not recognise it.

**The command to register.** Do not depend on a system `node`: this repo has already shipped a bug where a packaged app launched from Finder could not find `gh` on its PATH, and the same class applies here. Use Electron's own binary as the node runtime:

```json
{
  "type": "stdio",
  "command": "<process.execPath>",
  "args": ["<bridgePaths().script>"],
  "env": { "ELECTRON_RUN_AS_NODE": "1", "PTERM_MCP_SOCKET": "<bridgePaths().socket>" }
}
```

Verify `ELECTRON_RUN_AS_NODE` actually works for this before building on it: run the packaged binary with it set against a trivial script and confirm it behaves as node. Record what you observed. If it does not, stop and tell the controller rather than falling back to a bare `node`.

- [ ] **Step 1: Write the failing tests**

`mcpConfigPath()` must honour an env override (mirror `PTERM_CLAUDE_SETTINGS`; name the new one and document it) so no test can reach the real file. Then cover: a config with unrelated keys keeps every one of them across an install; an existing `mcpServers` map keeps its other servers; installing twice is idempotent; uninstall removes only ours; a config whose `mcpServers` is present but the wrong type is refused rather than overwritten; and a missing file installs into a fresh object.

The keep-everything test is the important one: that file holds 195KB of the user's unrelated state, and losing it is the worst thing this task can do.

- [ ] **Step 2: Run, implement, run.**

Back up before writing, as `backupIfPresent` does for the hooks.

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/install.ts tests/unit/mcpInstall.test.ts
git commit -m "Register the browser bridge in the user's Claude config"
```

---

### Task 6: The agent flag on a pane

**Files:**
- Modify: `src/renderer/workspace.ts`, `src/main/ipc/register.ts`, `src/shared/ipc.ts`
- Test: extend `tests/unit/mcpRoute.test.ts` or add a focused unit file

**Interfaces:**
- Produces: a browser pane created by a tool call carries `agentSessionId`, and it is cleared when that session's pane dies.

**Deliberately not persisted.** The flag means "an agent can act on this right now", and after a relaunch no agent can: the session is gone and the bridge's socket is new. Persisting it would restore a confined, stripped pane owned by nobody. So it lives in the runtime pane record and is absent from `store.ts`, and the pane comes back after a relaunch as an ordinary browser pane. Say this in the code, because the natural instinct is to persist everything a pane carries.

- [ ] **Step 1: Write the failing test.** A pane created for a session carries the id; when that session's pane is removed, the flag clears on the browser pane and the pane itself survives.
- [ ] **Step 2: Run, implement, run. Commit.**

---

### Task 7: Confinement on the pane

**Files:**
- Modify: `src/main/ipc/register.ts` (where `will-attach-webview` and the webview's `webContents` are already reached)
- Test: `tests/e2e/browserMcp.spec.ts`

**Interfaces:**
- Consumes: `isLoopbackUrl` (Task 1), the agent flag (Task 6).
- Produces: a navigation to a non-loopback origin in an agent-owned pane is prevented, and the attempt is reported.

Enforcement goes on `will-navigate` AND `will-redirect` for the pane's `webContents`, gated on the pane carrying `agentSessionId`. Checking only inside the navigate tool is not enough, and the reason is worth a comment: a tool that clicks a link makes the PAGE navigate, and no tool argument is involved.

- [ ] **Step 1: Write the failing e2e test**

Two routes, both required, because they fail differently:
1. `browser_navigate` to `https://example.com` returns an error naming the origin, and the pane's URL is unchanged.
2. A page served locally containing a link to a non-loopback origin: click it and confirm the pane did not leave the local page.

Assert host-side or through main: measured on this codebase, Playwright cannot enter a `<webview>`.

- [ ] **Step 2: Run and watch it fail. Implement. Run.**

- [ ] **Step 3: The acceptance sabotage.** Remove the `will-navigate` handler and confirm route 2 goes red while route 1 still passes. That asymmetry is the whole argument for enforcing on the pane, and it should be recorded rather than asserted.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/register.ts tests/e2e/browserMcp.spec.ts
git commit -m "Confine an agent-owned pane to loopback origins"
```

---

### Task 8: The bridge, and `browser_navigate` end to end

**Files:**
- Create: `src/main/mcp/bridge.ts`
- Modify: `src/main/ipc/register.ts` (start and stop the server with the app), `src/main/index.ts` (install on launch)
- Test: `tests/e2e/browserMcp.spec.ts`

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces: an MCP server advertising exactly one tool, `browser_navigate`, that opens a page in the calling session's pane.

The bridge is a plain node script run under `ELECTRON_RUN_AS_NODE`. It reads `PTERM_TAB_ID` from its own environment. **With no `PTERM_TAB_ID` it advertises zero tools and returns an explanatory error**, so a user-scoped registration cannot leak browser control into a Claude session running outside PRCLI. Cover that with a test: it is the difference between a scoped feature and an ambient one.

**There is no MCP SDK in this repo.** Checked on 2026-08-12: `package.json` names no `@modelcontextprotocol` package. So the bridge either implements the stdio protocol directly (initialize, `tools/list`, `tools/call`, newline-delimited JSON-RPC over stdin and stdout) or the plan gains a dependency.

Take the direct implementation. The surface this plan needs is three methods, the script must run under Electron's bundled node rather than the project's `node_modules` (it is spawned by Claude Code, not by the app), and this repo runs a `check-unused-deps` script that a dependency used by one installed script would sit awkwardly with. If while implementing you find the handshake needs materially more than those three methods, stop and tell the controller rather than growing it silently.

- [ ] **Step 1: Write the failing tests**, then implement, then run. Cover: `tools/list` returns the one tool with its schema; a call with no `PTERM_TAB_ID` refuses; a call with one navigates the pane; a call when the app is not running fails with a message naming that, rather than hanging.

- [ ] **Step 2: Commit**

---

### Task 9: The strip

**Files:**
- Create: `src/renderer/AgentStrip.tsx`
- Modify: `src/renderer/BrowserPane.tsx`, `src/shared/ipc.ts` (the event channel)
- Test: `tests/e2e/browserMcp.spec.ts`

Drawn only when the pane carries `agentSessionId`. Shows the last call and a marker that the pane is agent driven. A blocked navigation shows as `blocked: <origin>`.

- [ ] **Step 1: Write the failing e2e test.** The strip appears on an agent pane, names the last call, shows a refusal, and is absent from a pane the user opened by hand.
- [ ] **Step 2: Run, implement, run.**
- [ ] **Step 3: Full gate.** `npm test`, `npm run typecheck`, and one full `npm run e2e`, each as its own command. Triage any failure by attribution.
- [ ] **Step 4: Open the app and use it.** Register the bridge, start a Claude session in a project, and have it navigate its pane. Write down what you observed, including what the strip showed and what a refused origin did. Three defects on the browser pane milestone passed every automated gate and were found only this way.
- [ ] **Step 5: Commit**

---

## Self-Review

**Spec coverage:** transport and bridge to Tasks 2, 3, 8; routing and pane ownership to Tasks 4 and 6; the agent flag to Task 6; confinement to Tasks 1 and 7; the strip to Task 9; installation to Task 5. The six remaining tools are explicitly a second plan, as the Scope note says.

**Known gaps, stated rather than hidden:**
- The CDP `debugger` attach is NOT exercised by this plan. `browser_navigate` can be served by `loadURL` on the pane's `webContents` without it. The attach arrives with the first tool that needs it (`browser_read_page`), in the second plan, and the DevTools collision rule the spec names belongs there too. This plan should not build an attach it does not use.
- Hung-page detection, which the spec notes becomes available with the attach, likewise belongs to the second plan.

**Type consistency:** `agentSessionId`, `isLoopbackUrl`, `McpRequest`, `McpResponse`, `browserPaneFor`, `mcpConfigPath`, `bridgePaths` are spelled identically in every task that names them.
