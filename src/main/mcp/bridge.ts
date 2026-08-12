import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bridgePaths } from './install'

/**
 * The MCP bridge script, as text.
 *
 * **Read this before changing it.** Claude Code spawns this file, not the
 * app: the registration written by `install.ts` is
 * `{ command: <a system node>, args: [<this script>], env: { PTERM_MCP_SOCKET } }`.
 * Three consequences, each of which shaped what is below:
 *
 * - **It cannot import anything from this repo**, not even `protocol.ts`.
 *   There is no bundler between here and the user's disk and no
 *   `node_modules` beside the installed copy. Only `node:` builtins.
 * - **It runs on a node this app does not control.** Measured 2026-08-12: the
 *   registered runtime resolved to v25.8.1 on this machine while Electron
 *   bundles v24.18.0, and `ELECTRON_RUN_AS_NODE` is a silent no-op in the
 *   packaged app (`forge.config.ts` sets `RunAsNode: false`), which is why
 *   the runtime is a system node at all. So: CommonJS, no top-level await,
 *   nothing newer than it has to be.
 * - **Its stdout is the protocol.** Anything else written there corrupts the
 *   stream, so the script never logs. A failure is reported to the model as
 *   a tool error instead, which is the only channel that reaches anyone.
 *
 * The wire it speaks on stdio is MCP's own: newline-delimited JSON-RPC 2.0.
 * Three methods, which is the whole surface this plan needs: `initialize`,
 * `tools/list`, `tools/call`. Anything else is answered `-32601`, including
 * `ping` and every `resources/*` and `prompts/*` method, because this server
 * has no resources and no prompts and says so by not having them.
 *
 * The wire it speaks to the app on the unix socket is a different, smaller
 * protocol, this repo's own: one JSON request line in, one response line out
 * (`src/main/mcp/protocol.ts`). This script cannot import that module, so
 * the shape it writes (`id`, `paneId`, `tool`, `args`) is duplicated here by
 * necessity. `tests/integration/mcpBridge.test.ts` is where the two are held
 * together: it runs this script for real and parses what it sends with
 * `parseRequestLine` itself.
 *
 * `PTERM_TAB_ID` is the pane the calling Claude session is running in, put
 * into every pane's tmux environment by `SessionManager`. With no such
 * variable this script is running in a Claude session that pTerm did not
 * start, and it then advertises NO tools at all and refuses every call.
 * The registration is user-scoped, so it is read by every session on the
 * machine including ones started in a plain terminal, and browser control
 * must not leak into those.
 */
export function renderBridge(): string {
  return [
    '#!/usr/bin/env node',
    "'use strict'",
    '// pTerm MCP bridge. Installed by pTerm and rewritten on every launch:',
    '// edits here are lost. Source: src/main/mcp/bridge.ts.',
    '//',
    '// stdin/stdout carry newline-delimited JSON-RPC 2.0 (MCP stdio). The unix',
    '// socket carries pTerm\'s own one-line request/response protocol. Nothing',
    '// is ever logged: stdout is the protocol, and stderr would be noise in the',
    "// client's own log.",
    "const net = require('node:net')",
    '',
    "const SOCKET = process.env.PTERM_MCP_SOCKET || ''",
    "const PANE = process.env.PTERM_TAB_ID || ''",
    "const TOOL = 'browser_navigate'",
    '// Long enough for a dev server that is still compiling, short enough that a',
    '// wedged app answers the model instead of leaving the call outstanding.',
    'const TIMEOUT_MS = 30000',
    "const DEFAULT_PROTOCOL = '2025-06-18'",
    '',
    'const TOOLS = PANE ? [{',
    '  name: TOOL,',
    "  description: 'Open a URL in the pTerm browser pane belonging to THIS Claude session, " +
      'creating that pane if the session does not have one yet. Confined to loopback origins ' +
      '(localhost, 127.0.0.1, [::1], or a .localhost subdomain) over http or https: any other ' +
      "URL is refused. Never drives a browser pane the user opened by hand.',",
    '  inputSchema: {',
    "    type: 'object',",
    '    properties: {',
    "      url: { type: 'string', description: 'A loopback URL, for example http://localhost:3000/. " +
      "A bare host and port such as localhost:3000 is read as http.' }",
    '    },',
    "    required: ['url'],",
    '    additionalProperties: false',
    '  }',
    '}] : []',
    '',
    '// One id per socket request, independent of the JSON-RPC id: pTerm\'s line',
    '// protocol requires a finite NUMBER, and a JSON-RPC id may be a string.',
    'let nextRequestId = 1',
    '',
    'function write(message) {',
    "  process.stdout.write(JSON.stringify(message) + '\\n')",
    '}',
    '',
    'function ok(id, result) {',
    "  write({ jsonrpc: '2.0', id: id, result: result })",
    '}',
    '',
    'function fail(id, code, message) {',
    "  write({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } })",
    '}',
    '',
    '// An error the MODEL should see and can act on, rather than a protocol',
    '// error the client would swallow. Every refusal in this script is one of',
    '// these: a confined origin, a session outside pTerm, an app that is not',
    '// running. Each one is something the person reading the transcript can fix.',
    'function toolError(id, text) {',
    "  ok(id, { content: [{ type: 'text', text: text }], isError: true })",
    '}',
    '',
    'function toolResult(id, result) {',
    "  const text = typeof result === 'string' ? result : JSON.stringify(result)",
    "  ok(id, { content: [{ type: 'text', text: text }] })",
    '}',
    '',
    '// One connection per call, closed as soon as the answer arrives. The app',
    '// serves each line independently, and a bridge that held a socket open for',
    '// the life of a Claude session would keep a handle on an app the user may',
    '// have quit hours ago.',
    'function ask(request) {',
    '  return new Promise(function (resolve, reject) {',
    '    const socket = net.connect(SOCKET)',
    "    let buffer = ''",
    '    let settled = false',
    '    const finish = function (error, response) {',
    '      if (settled) return',
    '      settled = true',
    '      clearTimeout(timer)',
    '      socket.destroy()',
    '      if (error) reject(error)',
    '      else resolve(response)',
    '    }',
    '    const timer = setTimeout(function () {',
    "      finish(new Error('pTerm did not answer within ' + (TIMEOUT_MS / 1000) + 's'))",
    '    }, TIMEOUT_MS)',
    "    socket.setEncoding('utf8')",
    "    socket.on('connect', function () {",
    "      socket.write(JSON.stringify(request) + '\\n')",
    '    })',
    "    socket.on('data', function (chunk) {",
    '      buffer += chunk',
    "      const newline = buffer.indexOf('\\n')",
    '      if (newline === -1) return',
    '      try {',
    '        finish(null, JSON.parse(buffer.slice(0, newline)))',
    '      } catch (error) {',
    "        finish(new Error('pTerm sent a reply this bridge could not read'))",
    '      }',
    '    })',
    "    socket.on('error', function (error) {",
    "      finish(new Error('pTerm is not running, or its browser bridge has moved: ' +",
    "        (error && error.message ? error.message : String(error))))",
    '    })',
    "    socket.on('close', function () {",
    "      finish(new Error('pTerm closed the connection without answering'))",
    '    })',
    '  })',
    '}',
    '',
    'function call(id, params) {',
    '  const name = params && params.name',
    '  // First, and deliberately: with no pane there is nothing to open a',
    '  // browser for, and this is the check that keeps a user-scoped',
    '  // registration from reaching a session pTerm never started. The socket',
    '  // is not touched on this path at all.',
    '  if (!PANE) {',
    "    toolError(id, 'This Claude session is not running inside a pTerm pane (no PTERM_TAB_ID), " +
      "so pTerm has no browser pane to open for it. Start Claude in a pTerm pane to use this tool.')",
    '    return',
    '  }',
    '  if (name !== TOOL) {',
    "    toolError(id, 'pTerm has no tool called ' + String(name))",
    '    return',
    '  }',
    '  if (!SOCKET) {',
    "    toolError(id, 'pTerm did not tell this bridge where to reach it (no PTERM_MCP_SOCKET). " +
      "Reinstall the pTerm browser bridge from pTerm.')",
    '    return',
    '  }',
    '  ask({',
    '    id: nextRequestId++,',
    '    paneId: PANE,',
    '    tool: name,',
    "    args: (params && params.arguments) || {}",
    '  }).then(function (response) {',
    '    if (response && response.ok) toolResult(id, response.result)',
    "    else toolError(id, (response && response.error) || 'pTerm refused the call without saying why')",
    '  }, function (error) {',
    '    toolError(id, error && error.message ? error.message : String(error))',
    '  })',
    '}',
    '',
    'function handle(message) {',
    "  const id = message && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined",
    '  const method = message && message.method',
    '  // No id means a notification, which is owed no response at all, not even',
    "  // an error: 'notifications/initialized' arrives at every startup.",
    '  if (id === undefined || id === null) return',
    "  if (method === 'initialize') {",
    '    const asked = message.params && message.params.protocolVersion',
    '    ok(id, {',
    "      protocolVersion: typeof asked === 'string' ? asked : DEFAULT_PROTOCOL,",
    '      capabilities: { tools: {} },',
    "      serverInfo: { name: 'pterm-browser', version: '1.0.0' }",
    '    })',
    '    return',
    '  }',
    "  if (method === 'tools/list') {",
    '    ok(id, { tools: TOOLS })',
    '    return',
    '  }',
    "  if (method === 'tools/call') {",
    '    call(id, message.params)',
    '    return',
    '  }',
    "  fail(id, -32601, 'pTerm does not implement ' + String(method))",
    '}',
    '',
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', function (chunk) {",
    '  input += chunk',
    "  let newline = input.indexOf('\\n')",
    '  while (newline !== -1) {',
    '    const line = input.slice(0, newline).trim()',
    '    input = input.slice(newline + 1)',
    "    newline = input.indexOf('\\n')",
    "    if (line === '') continue",
    '    let message',
    '    try {',
    '      message = JSON.parse(line)',
    '    } catch (error) {',
    "      fail(null, -32700, 'pTerm could not parse that line as JSON')",
    '      continue',
    '    }',
    "    if (!message || typeof message !== 'object' || Array.isArray(message)) {",
    "      fail(null, -32600, 'pTerm expected a JSON-RPC object')",
    '      continue',
    '    }',
    '    handle(message)',
    '  }',
    '})',
    '',
    '// The client closing stdin is how it asks this to stop. Nothing is forced:',
    '// a call still in flight keeps its socket handle open, and the process ends',
    '// when that resolves and there is nothing left to do.',
    "process.stdin.on('end', function () {",
    '  process.stdin.pause()',
    '})',
    '',
    '// The client can go away mid-write; an unhandled EPIPE would be a crash',
    '// with no one left to report it to.',
    "process.stdout.on('error', function () {})",
    '',
  ].join('\n')
}

/**
 * Write the bridge script and make it executable.
 *
 * Called on every launch rather than only from an install gesture, for the
 * same reason `writeScript` (`hooks/install.ts`) is: an upgrade must replace
 * an older copy, and the registration in `~/.claude.json` names this path
 * whether or not the user has pressed anything since. Safe to call
 * repeatedly, since it writes the same bytes.
 *
 * The executable bit is not what runs it (the registration names a `node` and
 * passes this as an argument), but it means a user debugging the tool can run
 * the path they see in their config.
 */
export async function writeBridgeScript(): Promise<string> {
  const { script } = bridgePaths()
  await mkdir(dirname(script), { recursive: true })
  await writeFile(script, renderBridge(), 'utf8')
  await chmod(script, 0o755)
  return script
}
