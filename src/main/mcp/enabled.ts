import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// Declared with the other wire types, and imported rather than redeclared: the
// settings section reads this shape and cannot import from `src/main`.
import type { McpBridgeState } from '../../shared/ipc'
import { configRoot } from '../state/store'
import { writeBridgeScript } from './bridge'
import { bridgePaths, installMcpBridge, mcpConfigPath, uninstallMcpBridge } from './install'
import { probeListening, type McpServer } from './server'

/**
 * Whether the browser bridge is on, as the user last decided.
 *
 * Its own file under `configRoot()`, beside `mcp.sock` and `bin/pterm-mcp`,
 * rather than a field in `config.json`. Three reasons, in the order they
 * decided it:
 *
 * - **It must be distinguishable from "never installed".** The absence of the
 *   `pterm-browser` entry in `~/.claude.json` cannot carry this: a user who
 *   has never launched pTerm and a user who switched it off look identical
 *   there, and the second one's launch must not put the entry back. So the
 *   decision needs a record of its own, which is this file.
 * - **`config.json` would have cost a version bump.** `PTermConfig` is
 *   `version: 9` and `migrate` refuses a version it does not recognise by
 *   returning an empty config, so adding a field means v10, and an older
 *   build then reads the whole file as nothing: every project, pane and rule
 *   in it, to carry one boolean. Adding the field WITHOUT the bump is worse
 *   again, since an older build would write v9 back without it and silently
 *   turn the bridge on. This is not a new call: `src/main/update/store.ts`
 *   keeps the skipped version in its own `update.json` under this same
 *   directory for the same stated reason, and `prompts.json`, `todos.json`
 *   and `notes/` are all siblings of `config.json` rather than keys in it.
 * - **A test must be able to point it somewhere harmless.** `configRoot()`
 *   honours `PTERM_CONFIG_DIR`, which the e2e harness and the unit suites
 *   already set, so this needed no seventh guarded variable.
 */
export function mcpPreferencePath(): string {
  return join(configRoot(), 'mcp.json')
}

export type { McpBridgeState }

/**
 * The stored decision, defaulting to on.
 *
 * Total over anything the file can hold, for the reason `ConfigStore.read`
 * gives about its own file and with a sharper edge: this is read by
 * `whenReady` before the window is created, so a throw would be a text file
 * costing the user their app. Only an explicit boolean `false` is off;
 * everything else, including a missing file, a damaged one and an `enabled`
 * of the wrong type, is the default the user ruled for.
 */
export async function readMcpEnabled(): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(mcpPreferencePath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return true
    const enabled = (parsed as { enabled?: unknown }).enabled
    return typeof enabled === 'boolean' ? enabled : true
  } catch {
    return true
  }
}

/** Store the decision. Two-space JSON, because a user may read this by hand. */
export async function writeMcpEnabled(enabled: boolean): Promise<void> {
  await mkdir(configRoot(), { recursive: true })
  await writeFile(mcpPreferencePath(), `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

/**
 * The current setting, for the settings section to draw on mount, with the
 * socket asked whether it agrees.
 *
 * The setting alone would let this screen lie in the one direction that
 * matters. `mcpServer.listen` at `src/main/index.ts` can throw for reasons
 * that have nothing to do with the switch: a socket a live process is already
 * holding, or a `PTERM_CONFIG_DIR` deep enough to put the path over the macOS
 * 104-byte limit. The launch logs that and carries on, which is the right
 * trade for the app, but it left this panel saying `on` over a bridge that
 * was registered and not serving, with the only record on a stderr nobody
 * running the app reads. The same failure through the switch has always been
 * reported (`setMcpEnabled` pushes a note), so this was the launch path only.
 *
 * Asked by connecting rather than by remembering what launch answered. A
 * stashed launch error would cover that one cause and go stale the moment
 * anything else changed; a probe reports what is true when the panel opens,
 * and covers a socket file removed by hand or a server that has since gone
 * just as well.
 *
 * Only when the switch is on. Nothing listening is what off MEANS, so probing
 * then would put a warning under every correctly switched-off bridge.
 */
export async function mcpBridgeState(): Promise<McpBridgeState> {
  const enabled = await readMcpEnabled()
  if (!enabled) return { enabled, error: null }
  const socket = bridgePaths().socket
  if (await probeListening(socket)) return { enabled, error: null }
  return {
    enabled,
    error:
      `The browser server is not listening on ${socket}, so a Claude session cannot reach it. ` +
      'Turn this off and on again, or restart pTerm.',
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Throw the switch: store the decision, then make the running app agree with
 * it.
 *
 * **Off means unregister AND do not serve**, which is the user's ruling and
 * the reason this touches the socket at all. Removing the entry from
 * `~/.claude.json` is not enough on its own: the principal this feature is
 * scoped against is an agent with a shell, and it can write that entry back
 * for itself. Only a server that is not accepting actually denies it. It also
 * takes effect immediately rather than on the next launch, in both
 * directions: `McpServer.close` destroys the connections it is serving, so a
 * call already in flight is closed rather than left waiting (the bridge turns
 * that into a tool error), and `listen` binds again on the same path
 * afterwards because `close` set the server aside and removed the socket file.
 *
 * A session that was already running keeps whatever `~/.claude.json` said
 * when it started, so it may still have the tool listed after this. That is
 * the second half of why the socket matters: what it gets when it calls is a
 * connection refused, which its bridge reports as pTerm not running.
 *
 * **Never rejects.** `installMcpBridge` and `uninstallMcpBridge` both throw on
 * a `~/.claude.json` that cannot be read, does not parse, or is not a JSON
 * object, and that file is 191KB of the user's own state edited by other
 * tools. The launch path already keeps that off the window-opening path; this
 * keeps it off the switch, which must not fail the one thing it can always do
 * (stop serving) because of the one thing it cannot. What could not be done
 * comes back in `error` for the section to show.
 *
 * The returned `enabled` is read back off disk rather than echoed from the
 * argument, and the world is made to match THAT: if the write itself failed,
 * the answer, the running server and the next launch still all agree.
 */
export async function setMcpEnabled(enabled: boolean, server: McpServer): Promise<McpBridgeState> {
  const notes: string[] = []
  try {
    await writeMcpEnabled(enabled)
  } catch (error) {
    notes.push(`Could not save the setting: ${messageOf(error)}`)
  }

  const effective = await readMcpEnabled()
  if (effective) {
    try {
      await writeBridgeScript()
      await installMcpBridge()
    } catch (error) {
      notes.push(`Could not register the bridge in ${mcpConfigPath()}: ${messageOf(error)}`)
    }
    try {
      await server.listen(bridgePaths().socket)
    } catch (error) {
      notes.push(`Could not start the browser server: ${messageOf(error)}`)
    }
  } else {
    // Before the unregistration, which is the part that can fail: denying is
    // what off means, and it must not be skipped by a throw from the file
    // this app does not own.
    try {
      await server.close()
    } catch (error) {
      notes.push(`Could not stop the browser server: ${messageOf(error)}`)
    }
    try {
      await uninstallMcpBridge()
    } catch (error) {
      notes.push(`Could not unregister the bridge from ${mcpConfigPath()}: ${messageOf(error)}`)
    }
  }

  return { enabled: effective, error: notes.length > 0 ? notes.join(' ') : null }
}
