import { useEffect, useState } from 'react'
import type { BrowserAgentActivity } from '../shared/ipc'

/**
 * What the strip says about one activity, or the empty string before anything
 * has happened.
 *
 * A navigation reads as the URL alone: the strip already says whose pane this
 * is, so prefixing every ordinary line with a word would leave the one line
 * that matters, the refusal, no louder than the rest. `blocked:` is the only
 * label, and it is the only case the user has to notice.
 *
 * Local rather than exported, and read twice below (the line and its `title`),
 * so the two spellings live in one place rather than in JSX. Both are asserted
 * against a real pane in `tests/e2e/browserMcp.spec.ts`, which is the only
 * level that can: `vitest.config.mts` runs with no DOM, so nothing in
 * `tests/unit` can mount this component to see what it renders.
 */
function activityLabel(activity: BrowserAgentActivity | null): string {
  if (activity === null) return ''
  return activity.kind === 'blocked' ? `blocked: ${activity.origin}` : activity.url
}

/**
 * The line above an agent-owned browser pane: that an agent is driving it, and
 * the last thing the agent did to it.
 *
 * Drawn only for a pane carrying `agentSessionId`, which is the runtime-only
 * flag main sets when a `browser_navigate` call creates the pane, and which no
 * pane the user opened by hand can ever carry (see `agentSessions` in
 * `main/ipc/register.ts` for why config cannot vote on it). `BrowserPane` owns
 * that condition; this component assumes it.
 *
 * The last event rather than a log. A confined page can provoke a refusal as
 * often as it likes by looping `location.href`, so a list would be a place for
 * a page to write as much as it wanted into this app's chrome; one line cannot
 * grow. What that costs is history, deliberately: a refusal that scrolls past
 * before the user looks is gone, and the stderr line in `refusesNonLoopback`
 * is the record that keeps.
 *
 * Subscribed here rather than in `App`: a strip exists only for a pane where
 * these events can happen at all, and it already knows which pane it is. What
 * that rests on is that no event can arrive before this mounts: main creates
 * the pane, waits for the guest the mount attaches (`guestForPane`), and only
 * then navigates and reports. See `onBrowserAgentActivity` in `shared/ipc.ts`.
 */
export function AgentStrip({ paneId }: { paneId: string }) {
  const [last, setLast] = useState<BrowserAgentActivity | null>(null)

  useEffect(
    () =>
      window.pterm.onBrowserAgentActivity((event) => {
        // Every pane's events come down one channel; this is the filter that
        // keeps one agent's pane from reporting another's.
        if (event.paneId === paneId) setLast(event)
      }),
    [paneId],
  )

  const blocked = last?.kind === 'blocked'

  return (
    <div
      data-testid={`agentstrip-${paneId}`}
      // Above the pane's own chrome row and drawn like it, so the two read as
      // one block of chrome rather than as a banner over a page.
      className="flex items-center gap-1 border-b border-border bg-surface px-1 py-0.5 font-mono text-[11px]"
    >
      {/* The marker, and the only part that is always there: what makes this
          pane different is not that something happened in it, it is that it is
          not the user's to begin with. */}
      <span className="shrink-0 text-accent">agent</span>
      <span
        // `truncate` needs `min-w-0` to shrink inside a flex row, and the URL
        // is the part that has to give: the marker and the label are what the
        // user is reading at a glance.
        className={`min-w-0 flex-1 truncate ${blocked ? 'text-warn' : 'text-muted'}`}
        // The whole line on hover, since the box above ellipsises it and a
        // refused origin is worth being able to read in full.
        title={activityLabel(last)}
      >
        {activityLabel(last)}
      </span>
    </div>
  )
}
