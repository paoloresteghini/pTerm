import { HOOK_EVENTS, type HookEvent } from '../status/machine'

export interface HookEventMessage {
  /** The tab the event came from — the id half of its tmux session name. */
  tabId: string
  event: HookEvent
  /** Epoch milliseconds, stamped by the hook script. */
  at: number
}

/**
 * A pane that died, reporting how.
 *
 * This does not come from Claude. It comes from tmux's own `pane-died` hook,
 * which is the only place the answer is observable at all: an attached client
 * exits 0 whether its session was killed, its command crashed, or the user
 * typed `exit` — measured three times. So it has to be read off the dead pane
 * before the session goes away, and sent down the same socket everything else
 * uses.
 *
 * Exactly one of `status` and `signal` is filled in, because that is what tmux
 * gives: a status with no signal, or a signal name with no status. A line with
 * neither is refused rather than read as a clean exit.
 *
 * `Exit` is deliberately not a member of `HOOK_EVENTS`, which is what makes it
 * a sound discriminant: no Claude hook can ever produce this shape.
 */
export interface ExitEventMessage {
  tabId: string
  event: 'Exit'
  /** `#{pane_dead_status}` — absent when a signal killed the pane. */
  status?: number
  /** `#{pane_dead_signal}` — the signal's *name*: "kill", "segv", "term". */
  signal?: string
  at: number
}

/** Anything the socket or the spool can legitimately deliver. */
export type HookLine = HookEventMessage | ExitEventMessage

/**
 * A generous ceiling for a record of three short fields. Its job is to stop a
 * malformed or hostile write from becoming an unbounded allocation, not to
 * police the format — the parser does that.
 */
export const MAX_LINE_BYTES = 512

const TAB_ID_RE = /^[0-9a-f]{16}$/

/**
 * tmux's signal names, which are short and alphanumeric — "kill", "segv".
 *
 * Case is not pinned: 3.7b reports them lowercase, but a build that reported
 * `KILL` would otherwise have its deaths silently refused and shown grey,
 * which is the failure this path exists to remove. The shape is what matters —
 * this string is interpolated into JSON by the script and carried through the
 * app as a description of what killed a process.
 */
const SIGNAL_RE = /^[A-Za-z0-9]{1,12}$/

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * Read one line from the socket or the spool, or return null.
 *
 * Never throws. This is one of the app's two untrusted inputs, the other
 * being `parseRequestLine` (`src/main/mcp/protocol.ts`), which reads the MCP
 * bridge's own socket on the same terms: the socket here is reachable by
 * anything on the machine that can open it, and the spool is a plain file
 * anyone can append to. So this refuses everything it does not
 * positively recognise rather than accepting everything it cannot disprove —
 * and a rejected line is dropped silently, because a malformed write is not
 * something the user did and not something they can act on.
 */
export function parseHookLine(line: string): HookLine | null {
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

  const candidate = value as {
    tabId?: unknown
    event?: unknown
    at?: unknown
    status?: unknown
    signal?: unknown
  }
  if (typeof candidate.tabId !== 'string' || !TAB_ID_RE.test(candidate.tabId)) return null
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null

  if (candidate.event === 'Exit') {
    // tmux fills in one half or the other and never both, so either is
    // accepted alone — but a death reporting *neither* explains nothing, and
    // defaulting it to a status of 0 would render a crash as a clean `ended`,
    // the exact failure this whole path exists to remove.
    const death: { status?: number; signal?: string } = {}
    if (candidate.status !== undefined) {
      if (typeof candidate.status !== 'number') return null
      if (!Number.isSafeInteger(candidate.status) || candidate.status < 0) return null
      death.status = candidate.status
    }
    if (candidate.signal !== undefined) {
      // tmux's own names, which are short and lowercase ("kill", "segv",
      // "term"). Pinned to that shape because this string is about to be
      // carried through the app as a description of what killed a process.
      if (typeof candidate.signal !== 'string') return null
      if (!SIGNAL_RE.test(candidate.signal)) return null
      death.signal = candidate.signal
    }
    if (death.status === undefined && death.signal === undefined) return null
    return { tabId: candidate.tabId, event: 'Exit', ...death, at: candidate.at }
  }

  if (!isHookEvent(candidate.event)) return null
  return { tabId: candidate.tabId, event: candidate.event, at: candidate.at }
}

/** The exact bytes the hook script writes. Kept here so the two cannot drift. */
export function formatHookLine(message: HookLine): string {
  if (message.event === 'Exit') {
    // Written the way the script writes it: only the half tmux filled in.
    // `JSON.stringify` drops an undefined value, so a signal death carries no
    // `"status"` key at all rather than a null one the parser would refuse.
    return `${JSON.stringify({
      tabId: message.tabId,
      event: message.event,
      status: message.status,
      signal: message.signal,
      at: message.at,
    })}\n`
  }
  return `${JSON.stringify({ tabId: message.tabId, event: message.event, at: message.at })}\n`
}
