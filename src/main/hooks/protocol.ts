import { HOOK_EVENTS, type HookEvent } from '../status/machine'

export interface HookEventMessage {
  /** The tab the event came from — the id half of its tmux session name. */
  tabId: string
  event: HookEvent
  /** Epoch milliseconds, stamped by the hook script. */
  at: number
}

/**
 * A pane that died, reporting the status its command exited with.
 *
 * This does not come from Claude. It comes from tmux's own `pane-died` hook,
 * which is the only place the status is observable at all: an attached client
 * exits 0 whether its session was killed, its command crashed, or the user
 * typed `exit` — measured three times. So the status has to be read off the
 * dead pane before the session goes away, and sent down the same socket
 * everything else uses.
 *
 * `Exit` is deliberately not a member of `HOOK_EVENTS`, which is what makes it
 * a sound discriminant: no Claude hook can ever produce this shape.
 */
export interface ExitEventMessage {
  tabId: string
  event: 'Exit'
  /** The dead pane's `#{pane_dead_status}`. */
  status: number
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

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * Read one line from the socket or the spool, or return null.
 *
 * Never throws. This is the app's only untrusted input: the socket is
 * reachable by anything on the machine that can open it, and the spool is a
 * plain file anyone can append to. So this refuses everything it does not
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
  }
  if (typeof candidate.tabId !== 'string' || !TAB_ID_RE.test(candidate.tabId)) return null
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null

  if (candidate.event === 'Exit') {
    // A status is required, not defaulted. A missing one would default to 0 and
    // render a crash as a clean `ended` — the exact failure this whole change
    // exists to remove.
    if (typeof candidate.status !== 'number') return null
    if (!Number.isSafeInteger(candidate.status) || candidate.status < 0) return null
    return { tabId: candidate.tabId, event: 'Exit', status: candidate.status, at: candidate.at }
  }

  if (!isHookEvent(candidate.event)) return null
  return { tabId: candidate.tabId, event: candidate.event, at: candidate.at }
}

/** The exact bytes the hook script writes. Kept here so the two cannot drift. */
export function formatHookLine(message: HookLine): string {
  if (message.event === 'Exit') {
    return `${JSON.stringify({
      tabId: message.tabId,
      event: message.event,
      status: message.status,
      at: message.at,
    })}\n`
  }
  return `${JSON.stringify({ tabId: message.tabId, event: message.event, at: message.at })}\n`
}
