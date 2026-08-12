import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FALLBACK_DIRS, resolveBin } from '../bin/resolve'
import { backupIfPresent } from '../hooks/install'
import { configRoot } from '../state/store'

/**
 * The key this app owns inside `mcpServers`, and the only key in the user's
 * Claude config it will ever write.
 *
 * Claude Code namespaces a server's tools by this name, so a session sees
 * `mcp__pterm-browser__browser_navigate`.
 */
export const MCP_SERVER_NAME = 'pterm-browser'

/** One `mcpServers` entry, in the stdio shape Claude Code reads. */
export interface McpServerEntry {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The user's Claude config, which this module treats as opaque apart from
 * one key. Everything else in it belongs to the user or to Claude Code.
 */
export type ClaudeConfig = Record<string, unknown>

/**
 * `PTERM_MCP_CONFIG` exists for the same reason `PTERM_CLAUDE_SETTINGS` does,
 * and the file it guards is the larger of the two: read on 2026-08-12, the
 * real `~/.claude.json` was 191KB across 88 top-level keys, including a
 * `projects` map with 49 entries of per-directory history and permissions.
 * A test that read-modify-wrote the real one could destroy all of it, so
 * `tests/unit/mcpInstall.test.ts` sets this in `beforeEach`. Exactly one test
 * there unsets it, to assert the fallback below, and that one computes a path
 * without opening it.
 *
 * Note which file this is. MCP servers live at the ROOT of `~/.claude.json`;
 * the hooks this app also installs live in a different file,
 * `~/.claude/settings.json`, which is what `claudeSettingsPath()` returns.
 * The two are easy to confuse and an entry written to the wrong one would
 * simply never be read.
 *
 * Claude Code also keeps per-project servers under `projects[<cwd>].mcpServers`.
 * This module does not touch those: the registration is user-scoped, so that
 * one entry covers every project rather than putting a pTerm-owned key inside
 * the record of each of the user's repositories.
 */
export function mcpConfigPath(): string {
  return process.env.PTERM_MCP_CONFIG ?? join(homedir(), '.claude.json')
}

/**
 * Absolute path to a usable `node`, or `'node'` when none is found.
 *
 * The bridge is spawned by Claude Code, not by this app, so it needs a
 * runtime named in the registration itself. Two candidates were measured on
 * 2026-08-12 before this one was chosen:
 *
 * - `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, which is what the plan
 *   originally specified. It works for the development binary and does
 *   nothing at all for the shipped app: `forge.config.ts` sets
 *   `FuseV1Options.RunAsNode: false`, so the packaged binary ignores the
 *   variable, launches the app instead, and exits 0 having written nothing to
 *   stdout or stderr. Reading the fuse wire off the two binaries confirmed it
 *   (`RunAsNode` = '0' packaged, '1' in `node_modules`). A registration that
 *   works when you run from source and is inert in the DMG is the worst
 *   available outcome, so it was rejected rather than worked around.
 * - A bare `node`, which fails for the reason `ghBin` documents: an app
 *   launched from Finder or the Dock inherits launchd's `PATH` and cannot see
 *   Homebrew.
 *
 * So this resolves the same way `gh` does, through the same helper. That is
 * how this repo already answered this exact bug once: it hardened the lookup
 * rather than dropping the dependency. When nothing is found the bare name is
 * returned and the spawn fails with ENOENT, which is visible; the discarded
 * fuse approach failed by exiting 0 in silence, which is not.
 *
 * `PTERM_NODE_BIN` overrides everything, for the same reasons `PTERM_GH_BIN`
 * does and one more: `FALLBACK_DIRS` covers Homebrew and the system
 * directories, and an nvm-managed node lives under `~/.nvm/versions/node`,
 * which is in none of them.
 */
export function nodeBin(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirs: readonly string[] = FALLBACK_DIRS,
): string {
  return env.PTERM_NODE_BIN ?? resolveBin('node', env, fallbackDirs)
}

/**
 * Everything the MCP bridge keeps on disk, all of it under `configRoot()` so
 * that `PTERM_CONFIG_DIR` moves the script and the socket together, exactly
 * as `hookPaths()` does for the hook bridge.
 */
export function bridgePaths(): { dir: string; script: string; socket: string } {
  const dir = configRoot()
  return {
    dir,
    script: join(dir, 'bin', 'pterm-mcp'),
    socket: join(dir, 'mcp.sock'),
  }
}

/**
 * The entry this app registers.
 *
 * Both paths are absolute and both can go stale: `PTERM_CONFIG_DIR` can move
 * the script, and a Homebrew upgrade or a switch of node manager can move the
 * runtime. `installMcpBridge` is what keeps the registration true, by
 * rebuilding this on each launch that finds the bridge on (`src/main/index.ts`)
 * and rewriting the entry when it differs from what is stored.
 *
 * No `ELECTRON_RUN_AS_NODE` here. See `nodeBin` for what was measured; a
 * variable that the shipped binary ignores would be a claim about this app
 * that is not true of it.
 */
export function bridgeEntry(): McpServerEntry {
  const { script, socket } = bridgePaths()
  return {
    type: 'stdio',
    command: nodeBin(),
    args: [script],
    env: { PTERM_MCP_SOCKET: socket },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asConfig(value: unknown): ClaudeConfig {
  return isRecord(value) ? value : {}
}

function serversOf(config: ClaudeConfig): Record<string, unknown> {
  return isRecord(config.mcpServers) ? config.mcpServers : {}
}

/**
 * Whether `mcpServers` is a shape this module can carry through untouched.
 *
 * Deliberately narrower than the hooks module's equivalent, which also
 * refuses an individual event whose value is the wrong type. It has to: its
 * `hooksOf` filters those out, so a write built from it would drop them.
 * `serversOf` does no such filtering, and `mergeMcpServer` spreads whatever
 * it found straight back, so a single server entry of any shape at all
 * survives untouched and needs no refusal. Only `mcpServers` itself being
 * something other than an object is unrecognised, because that is the one
 * case where writing an object over it would destroy something.
 *
 * `null` counts as absent rather than unrecognised: it is how a key gets
 * emptied in JSON, not a shape that needs a human to look at it.
 */
function hasUnrecognisedServers(config: ClaudeConfig): boolean {
  const servers = config.mcpServers
  if (servers === undefined || servers === null) return false
  return !isRecord(servers)
}

/** Throws rather than silently repairing. See `hasUnrecognisedServers`. */
function assertRecognisedServers(config: ClaudeConfig): void {
  if (!hasUnrecognisedServers(config)) return
  throw new Error(
    `${mcpConfigPath()}: "mcpServers" is not an object, which is a shape pTerm does not ` +
      'recognise. Refusing to modify it. Fix or remove that key by hand.',
  )
}

/**
 * Whether the stored entry already says exactly what `bridgeEntry` would.
 *
 * Compared field by field rather than by stringifying both, so that a
 * hand-reordered `env` or a differently ordered object does not read as a
 * difference. That matters more than it looks: `installMcpBridge` runs on
 * every launch the bridge is switched on for, which is every launch by
 * default, and a comparison that saw a difference where there is none would
 * rewrite a 191KB file every time the app started.
 */
function sameEntry(current: unknown, entry: McpServerEntry): boolean {
  if (!isRecord(current)) return false
  if (current.type !== entry.type || current.command !== entry.command) return false
  if (!Array.isArray(current.args)) return false
  if (current.args.length !== entry.args.length) return false
  if (current.args.some((arg, index) => arg !== entry.args[index])) return false
  const env = current.env
  if (!isRecord(env)) return false
  const keys = Object.keys(env)
  if (keys.length !== Object.keys(entry.env).length) return false
  return keys.every((key) => env[key] === entry.env[key])
}

/**
 * Add or update this app's entry, touching nothing else.
 *
 * Every other top-level key, and every other server, is spread straight back
 * out. That is the whole design and the property the tests care about most:
 * the file holds 191KB of state this module has no business in, and losing
 * any of it is the worst thing this task could do.
 *
 * Pure and non-mutating, so the value that would be written and the value a
 * caller inspects to decide whether to write cannot disagree.
 *
 * `changed` is false when the stored entry already matches, which is what
 * makes both install and the unattended refresh no-ops on a config that is
 * already correct.
 */
export function mergeMcpServer(
  config: unknown,
  entry: McpServerEntry,
): { next: ClaudeConfig; changed: boolean } {
  const base = asConfig(config)
  assertRecognisedServers(base)
  const servers = serversOf(base)
  if (sameEntry(servers[MCP_SERVER_NAME], entry)) return { next: base, changed: false }
  return {
    next: { ...base, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } },
    changed: true,
  }
}

/**
 * Whether this app's server is registered.
 *
 * Total over any input, including the shapes `mergeMcpServer` refuses: a read
 * that throws would leave a caller unable to report state at all, and
 * refusing to write is install's job rather than the read's.
 *
 * This is also what confines `refreshMcpBridge`. Our entry can only be found
 * inside an `mcpServers` that is an object, so a config carrying any other
 * shape there is never installed, and the unattended refresh never reaches
 * the merge that would have to refuse it.
 */
export function isMcpInstalled(config: unknown): boolean {
  const servers = asConfig(config).mcpServers
  return isRecord(servers) && isRecord(servers[MCP_SERVER_NAME])
}

/**
 * Remove only this app's entry.
 *
 * An `mcpServers` still holding someone else's server keeps the key; one
 * where ours was the only server loses it, because `"mcpServers": {}` left
 * behind is litter in a file the user reads by hand. A config with no
 * `mcpServers` at all does not gain one.
 *
 * Total, like `isMcpInstalled` and unlike `mergeMcpServer`: a shape this
 * module does not recognise cannot be holding our entry, so there is nothing
 * to remove and nothing to refuse. Uninstall writes only when it removed
 * something, so such a file is left exactly as it was found.
 */
export function unmergeMcpServer(config: unknown): { next: ClaudeConfig; removed: boolean } {
  const base = asConfig(config)
  const servers = base.mcpServers
  if (!isRecord(servers) || !(MCP_SERVER_NAME in servers)) return { next: base, removed: false }

  const kept = { ...servers }
  delete kept[MCP_SERVER_NAME]

  const next: ClaudeConfig = { ...base }
  if (Object.keys(kept).length > 0) next.mcpServers = kept
  else delete next.mcpServers
  return { next, removed: true }
}

/**
 * Read the config, or `{}` when there is no file.
 *
 * Three separate refusals, because overwriting this file with something built
 * from a misreading is the failure that matters. A file that cannot be read
 * at all, one that does not parse, and one that parses to something other
 * than an object all throw. ENOENT is the only case that genuinely means
 * there was nothing to lose.
 *
 * The non-object case is stricter than the hooks module, whose `asSettings`
 * quietly treats a parsed array or string as `{}`. Here that would mean
 * replacing a file whose contents we plainly did not understand.
 */
async function readConfig(path: string): Promise<ClaudeConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error(`${path}: expected a JSON object at the top level. Refusing to overwrite it.`)
  }
  return parsed
}

/**
 * Back up, then write.
 *
 * The backup is timestamped rather than a single `.bak` for the reason the
 * hooks installer gives: a write a week later must not overwrite the copy
 * that predates pTerm entirely. `backupIfPresent` is imported rather than
 * reimplemented, for the reason its own comment gives: it is exported so that
 * a user's config is modified one way in this app rather than several. This
 * module is its third caller, after the hooks installer and the shell one.
 *
 * Two-space JSON with no trailing newline, because that is what Claude Code
 * itself writes: measured on 2026-08-12, the real file is pretty-printed at
 * two spaces and its last byte is `}`. Matching it keeps this app's one-key
 * change from landing as a whole-file reformat.
 */
async function writeConfig(path: string, config: ClaudeConfig): Promise<void> {
  await backupIfPresent(path)
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
}

/**
 * Register the bridge, or bring an existing registration up to date with the
 * paths this launch resolved.
 *
 * **No Install gesture is needed, and there is now an Uninstall one.** The
 * user ruled that the bridge registers itself the first time pTerm opens
 * rather than waiting to be asked, so `src/main/index.ts` calls this on every
 * launch that finds the switch on, and the switch defaults to on: a user who
 * never opens Settings does find an MCP server registered for them, which is
 * worth stating here rather than leaving to be discovered. What they also have
 * is a way to say no. `McpSection.tsx` (Settings, under Hooks) turns the
 * bridge off, which unregisters the entry, stops the socket and is remembered
 * across launches, and turns it back on again; both go through `setMcpEnabled`
 * in `mcp/enabled.ts`, which is this function's second caller.
 *
 * Writes only when something actually changed, so a second launch that
 * resolves the same runtime and script leaves the file's mtime alone. Throws
 * on a config that cannot be read or whose `mcpServers` is unrecognised,
 * rather than repairing either.
 */
export async function installMcpBridge(): Promise<{
  configPath: string
  entry: McpServerEntry
  changed: boolean
}> {
  const configPath = mcpConfigPath()
  const entry = bridgeEntry()
  const { next, changed } = mergeMcpServer(await readConfig(configPath), entry)
  if (changed) await writeConfig(configPath, next)
  return { configPath, entry, changed }
}

export async function uninstallMcpBridge(): Promise<{ configPath: string; removed: boolean }> {
  const configPath = mcpConfigPath()
  const { next, removed } = unmergeMcpServer(await readConfig(configPath))
  if (removed) await writeConfig(configPath, next)
  return { configPath, removed }
}

/**
 * Re-point an existing registration at the paths this launch actually
 * resolves, so a stale one heals itself.
 *
 * Both paths in the entry are absolute and neither is stable for the life of
 * an install: a Homebrew upgrade or a change of node manager moves the
 * runtime, and a reinstalled development tree or a moved app bundle moves the
 * script. Nobody would notice by hand, because the symptom is a tool that is
 * simply never available.
 *
 * **Nothing in `src/` calls this, and what ships does the opposite of what it
 * was written for.** It only ever updates a registration that is already
 * there, on the rule that a config with no pTerm server in it belongs to
 * someone who never asked for one. The app registers on every launch the
 * switch is on for instead (`installMcpBridge`, from `src/main/index.ts`), and
 * the switch is what a user who never asked for one uses now, so that rule is
 * not this app's behaviour and this function is not the code path anyone is
 * running.
 * No task in this plan reactivates or removes it, so this is not a temporary
 * gap awaiting a scheduled fix; it stays dead-but-tested code, still covered
 * by its own five tests in `tests/unit/mcpInstall.test.ts`, until that
 * decision is made elsewhere. Read those tests as a description of THIS
 * function and of nothing that runs.
 *
 * The `isMcpInstalled` check is also what keeps the refusal ahead of the
 * repair. Our entry can only live inside an `mcpServers` that is an object,
 * so an unrecognised one is never installed, and this returns without writing
 * rather than rewriting a shape it does not understand just because a path
 * moved.
 */
export async function refreshMcpBridge(): Promise<{ changed: boolean }> {
  const configPath = mcpConfigPath()
  const config = await readConfig(configPath)
  if (!isMcpInstalled(config)) return { changed: false }
  const { next, changed } = mergeMcpServer(config, bridgeEntry())
  if (changed) await writeConfig(configPath, next)
  return { changed }
}
