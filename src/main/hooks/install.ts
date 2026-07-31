import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS, type HookEvent } from '../status/machine'

export type ClaudeSettings = Record<string, unknown>

/**
 * One group in an event's array, as Claude Code reads it.
 *
 * The fields are `unknown` rather than the shape we expect, because a group
 * comes from a file this app does not own. `commandsOf` below is what
 * actually reads a group's commands, and it re-validates every field itself
 * rather than trusting this type — this interface exists only so `merge` has
 * something to name when it builds a group of its own.
 */
interface HookGroup {
  matcher?: unknown
  hooks?: unknown
}

/**
 * `PRCLI_CLAUDE_SETTINGS` exists for the same reason `PRCLI_CONFIG_DIR` does,
 * and matters more: this file is read by every live Claude session on the
 * machine, so a test that wrote the real one could break work in progress in
 * a dozen windows at once.
 */
export function claudeSettingsPath(): string {
  return process.env.PRCLI_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
}

/**
 * What goes in `command` for one event.
 *
 * The event name is an argument rather than something parsed out of stdin:
 * PostToolUse payloads carry tool output and can be large, and the state
 * machine needs the name and nothing else. The path is quoted because a home
 * directory may contain spaces.
 */
export function hookCommand(hookPath: string, event: HookEvent): string {
  return `"${hookPath}" ${event}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asSettings(value: unknown): ClaudeSettings {
  return isRecord(value) ? value : {}
}

function hooksOf(settings: ClaudeSettings): Record<string, HookGroup[]> {
  const hooks = settings.hooks
  if (!isRecord(hooks)) return {}
  const out: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (Array.isArray(groups)) out[event] = groups as HookGroup[]
  }
  return out
}

/**
 * Every `command` string a group actually carries.
 *
 * `settings` arrives as `unknown`, so a "group" here is not guaranteed to
 * look like `HookGroup` at all. A half-finished install, a hand-edited file,
 * or a future Claude Code version could leave a group with no `hooks` array,
 * a `hooks` value that is itself an object rather than an array, a `command`
 * that is a number, or an array entry that is `null`. None of those are ours
 * to repair, but none of them should be able to crash a read of the file
 * either — so anything that doesn't parse simply contributes no commands,
 * the same as a group that legitimately has none.
 */
function commandsOf(group: unknown): string[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return []
  const commands: string[] = []
  for (const entry of group.hooks as unknown[]) {
    if (isRecord(entry) && typeof entry.command === 'string') commands.push(entry.command)
  }
  return commands
}

/**
 * Whether a group is one PRCLI itself added.
 *
 * Matches on the *quoted* hook path, not the bare path — `hookCommand` always
 * wraps the path in `"..."`, so a command is only recognised as ours when it
 * starts with `"${hookPath}"` followed immediately by the closing quote. That
 * stops a different tool's hook whose path happens to share a prefix with
 * ours (e.g. `/Users/x/.prcli-other/...` against `/Users/x/.prcli/...`) from
 * being mistaken for one of our own.
 */
function isOurs(group: unknown, hookPath: string): boolean {
  const prefix = `"${hookPath}"`
  return commandsOf(group).some((command) => command.startsWith(prefix))
}

/**
 * Append PRCLI's entry to every subscribed event, touching nothing else.
 *
 * Appending is the whole design. The real file holds five of these seven
 * events already: one carries a `matcher`, two hold more than one group, and
 * every one of them belongs to something the user installed on purpose. So
 * this adds an element to an array and never edits, reorders or replaces one.
 *
 * PRCLI's own `PreToolUse` group carries no matcher, so it fires for every
 * tool rather than for the one the neighbouring entry happens to filter on.
 *
 * Pure, and non-mutating: the install screen renders the diff from this call
 * and the writer writes the result of the same call, so the two cannot
 * disagree about what is about to happen. Every pre-existing group array is
 * copied before anything is pushed onto it, and no pre-existing group object
 * is ever written to — only appended past.
 */
export function merge(
  settings: unknown,
  hookPath: string,
): { next: ClaudeSettings; added: HookEvent[] } {
  const base = asSettings(settings)
  const hooks = hooksOf(base)
  const nextHooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(hooks)) nextHooks[event] = [...groups]

  const added: HookEvent[] = []
  for (const event of HOOK_EVENTS) {
    const groups = nextHooks[event] ?? []
    if (groups.some((group) => isOurs(group, hookPath))) continue
    const ours: HookGroup = { hooks: [{ type: 'command', command: hookCommand(hookPath, event) }] }
    nextHooks[event] = [...groups, ours]
    added.push(event)
  }

  return { next: { ...base, hooks: nextHooks }, added }
}

/** Whether every subscribed event already carries this hook path. */
export function isInstalled(settings: unknown, hookPath: string): boolean {
  const hooks = hooksOf(asSettings(settings))
  return HOOK_EVENTS.every((event) =>
    (hooks[event] ?? []).some((group) => isOurs(group, hookPath)),
  )
}

/**
 * Remove only PRCLI's own groups.
 *
 * An event whose array still holds someone else's hook keeps the array; an
 * event where ours was the only group loses the key, because `SessionEnd: []`
 * left behind is litter in a file the user reads by hand. If nothing is left
 * at all the `hooks` key goes too, so uninstall restores the file it found.
 */
export function unmerge(
  settings: unknown,
  hookPath: string,
): { next: ClaudeSettings; removed: HookEvent[] } {
  const base = asSettings(settings)
  const hooks = hooksOf(base)
  const nextHooks: Record<string, HookGroup[]> = {}
  const removed: HookEvent[] = []

  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.filter((group) => !isOurs(group, hookPath))
    if (kept.length !== groups.length && (HOOK_EVENTS as readonly string[]).includes(event)) {
      removed.push(event as HookEvent)
    }
    if (kept.length > 0) nextHooks[event] = kept
  }

  const next: ClaudeSettings = { ...base }
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks
  else delete next.hooks
  return { next, removed }
}

/**
 * Existing `afplay` hooks on events PRCLI subscribes to.
 *
 * Not a problem to fix, a fact to show. This machine already plays Funk on
 * Notification and Glass on Stop, which are two of the three sounds the parent
 * spec's default rules name — so PRCLI's defaults ship silent and the install
 * screen says why, rather than leaving it to be discovered by ear.
 */
export function soundCollisions(settings: unknown): { event: string; command: string }[] {
  const hooks = hooksOf(asSettings(settings))
  const found: { event: string; command: string }[] = []
  for (const event of HOOK_EVENTS) {
    for (const group of hooks[event] ?? []) {
      for (const command of commandsOf(group)) {
        if (command.includes('afplay')) found.push({ event, command })
      }
    }
  }
  return found
}
