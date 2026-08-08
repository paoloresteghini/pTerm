/**
 * Who gives up their WebGL context when the budget is full.
 *
 * Chromium caps LIVE WebGL contexts per renderer process at 16 — measured
 * 2026-08-08 in this app's own Electron by creating 40 contexts on
 * document-attached canvases and counting the survivors: exactly 16, and the
 * survivors were the LAST 16 created. Past the cap, `getContext` does NOT
 * fail; Chromium force-loses an existing context instead, choosing by its own
 * least-recently-DRAWN order. So a pane that is on screen but quiet — an idle
 * Claude Code session waiting for a prompt draws nothing — is exactly the kind
 * of pane Chromium picks, and xterm's fallback to the DOM renderer is
 * permanent once it happens.
 *
 * That is the whole reason this file exists: the app keeps its own count below
 * Chromium's cap and evicts by the user's activity rather than by paint
 * activity, so the panes someone is actually working in keep the renderer that
 * can draw Claude Code's box and block characters.
 */

/**
 * The holder that has gone longest without use, or null when `holders` is
 * empty.
 *
 * `lastUsed` is a monotonic counter, not a clock: two panes touched in the
 * same millisecond still order correctly, and no eviction decision can be
 * changed by the machine's clock moving. A holder missing from `lastUsed` is
 * treated as never used, which makes it the first to go — the only way to be
 * missing is to have been recorded as a holder without ever being touched, and
 * a context nobody has ever used is the cheapest one to take.
 *
 * Ties break on `holders` order rather than arbitrarily, so the same inputs
 * always name the same victim and a test can assert which one.
 */
export function leastRecentlyUsed(holders: string[], lastUsed: Map<string, number>): string | null {
  let victim: string | null = null
  let victimUse = Number.POSITIVE_INFINITY
  for (const holder of holders) {
    const used = lastUsed.get(holder) ?? -1
    if (used < victimUse) {
      victim = holder
      victimUse = used
    }
  }
  return victim
}

/**
 * How many panes may hold a WebGL context at once.
 *
 * Twelve rather than Chromium's sixteen: the app is not the only thing in the
 * process that can take a context, and a budget that sits exactly on the cap
 * would hand the decision back to Chromium — which chooses by paint activity —
 * the moment anything else asked for one.
 *
 * `PTERM_WEBGL_LIMIT` overrides it. That exists so an e2e can drive eviction
 * and recovery with three panes instead of thirteen: the tab bar stops being
 * clickable long before thirteen tabs fit in it, so a test at the real budget
 * is not merely slow but impossible to drive through the UI.
 *
 * Anything unparseable or below 1 falls back to the default rather than
 * disabling the renderer for everyone who fat-fingers the variable.
 */
export const WEBGL_PANE_BUDGET_DEFAULT = 12

export function webglPaneBudget(raw: string | undefined): number {
  if (raw === undefined) return WEBGL_PANE_BUDGET_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return WEBGL_PANE_BUDGET_DEFAULT
  return parsed
}
