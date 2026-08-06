import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from './lib/cn'
import type { HistoryEntry, HistoryScope } from '../shared/ipc'

/**
 * How long ago `ts` happened, in the coarsest unit that still says something.
 *
 * `ts` is epoch SECONDS, which is what the zsh hook writes, while `now` is
 * epoch milliseconds because that is what `Date.now()` returns; the conversion
 * is here so no caller has to remember which side it is on.
 *
 * A `ts` in the future reads as `just now` rather than as a negative age. The
 * clock that wrote it is the shell's and the clock reading it is this window's,
 * and they are allowed to disagree by a second or two.
 */
export function historyAgo(ts: number, now: number): string {
  const seconds = Math.floor(now / 1000) - ts
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * The list of past commands, rising from the bottom edge of one pane.
 *
 * Deliberately NOT a Radix dialog, unlike every other floating thing in this
 * app. A dialog is modal at the window level and traps focus there; this is
 * anchored inside a single pane and has to leave the rest of the window alone.
 * What it does take is DOM focus, on its own filter box, on mount. That is the
 * whole reason `Terminal.tsx` intercepts exactly one key: once xterm has lost
 * focus, every keystroke after the opening Up is React's already, so there is
 * nothing further to intercept.
 *
 * The component owns the selection and the filter text and nothing else. The
 * entries and the scope are handed down, because refetching on a scope change
 * is an IPC call and `App` is what holds the project to make it about.
 */
export function HistoryOverlay({
  entries,
  scope,
  onPick,
  onScopeChange,
  onDismiss,
}: {
  /** Newest first, already scoped and deduped by `selectHistory` in main. */
  entries: HistoryEntry[]
  scope: HistoryScope
  /** Type this command onto the prompt and close. Never runs it. */
  onPick: (cmd: string) => void
  onScopeChange: (scope: HistoryScope) => void
  onDismiss: () => void
}) {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Frozen at mount so the ages on screen do not tick while the list is being
  // read. The overlay lives for a few seconds; a row that renumbered itself
  // mid-selection would be movement with nothing behind it.
  const [now] = useState(() => Date.now())

  // Case-insensitive substring, matching what `selectHistory` does with its own
  // filter. Applied here rather than through another IPC round trip because the
  // scoped list is already in hand and a keystroke should not wait on main.
  const shown = useMemo(() => {
    const needle = filter.toLowerCase()
    if (needle === '') return entries
    return entries.filter((entry) => entry.cmd.toLowerCase().includes(needle))
  }, [entries, filter])

  // Back to the top when the SCOPE changes, not when `entries` does. The two
  // look interchangeable and are not: `App` refetches whenever the overlay
  // opens as well as when it closes, so a fresh array arrives a moment after
  // mount even though nothing about the list has changed, and keying this on
  // `entries` would yank the selection back to the top under a user who had
  // already pressed Down. Scope and filter are the only two things that
  // actually replace the list, and filter resets at the keystroke below.
  useEffect(() => {
    setSelected(0)
  }, [scope])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Clamped on the way out rather than only on the way in: `selected` is an
  // index into a list that can shrink underneath it, and a row that no longer
  // exists must not be what Enter picks.
  const index = Math.min(selected, Math.max(0, shown.length - 1))

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      // Nothing to pick means nothing happens, and the overlay stays put: a
      // filter that matched nothing is a typo, not a request to close.
      const picked = shown[index]
      if (picked) onPick(picked.cmd)
      return
    }
    if (event.key === 'Tab') {
      // Without this the browser moves focus out of the filter box and the
      // next keystroke goes somewhere nobody asked for.
      event.preventDefault()
      onScopeChange(scope === 'project' ? 'all' : 'project')
      return
    }
    // Clamped at both ends rather than wrapping. Up is also the key that opened
    // this, so a wrap at the top would send a second press to the far end of a
    // list the user has not read yet.
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(Math.max(0, index - 1))
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(Math.min(shown.length - 1, index + 1))
    }
  }

  return (
    <div
      data-testid="history-overlay"
      // The same opt-out the command palette puts on its input, for the same
      // reason: a ⌘W aimed at the filter box would otherwise close the pane
      // this overlay is anchored to and destroy its session.
      data-shortcuts="off"
      onKeyDown={onKeyDown}
      // Above the divider strips, which sit in an overlay of their own at z-20
      // on the group container (`App.tsx`). Equal z-index would hand it to the
      // one later in the document, which is theirs.
      className={cn(
        'absolute inset-x-0 bottom-0 z-30 flex max-h-[60%] flex-col',
        'border-t border-border bg-surface text-[11px]',
      )}
    >
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {shown.map((entry, row) => (
          // Keyed by the pair, not by `cmd` alone: `selectHistory` dedupes by
          // command text within one scope, but the key has to survive the wider
          // scope arriving too.
          <div
            key={`${entry.ts}:${entry.cmd}`}
            data-testid={`history-row-${row}`}
            data-selected={row === index ? 'true' : 'false'}
            className={cn(
              'flex gap-2 px-2 py-0.5',
              row === index ? 'bg-border text-fg' : 'text-muted',
            )}
          >
            <span className="flex-1 truncate font-mono">{entry.cmd}</span>
            <span className="shrink-0 text-faint">{historyAgo(entry.ts, now)}</span>
          </div>
        ))}
        {shown.length === 0 ? (
          <p data-testid="history-empty" className="px-2 py-2 text-faint">
            No matching commands.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-2 py-1">
        <input
          ref={inputRef}
          data-testid="history-filter"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value)
            setSelected(0)
          }}
          placeholder="Filter"
          spellCheck={false}
          className="min-w-0 flex-1 border-none bg-transparent text-fg placeholder:text-faint focus:outline-none"
        />
        <span className="shrink-0 text-faint">
          <span data-testid="history-scope" className="text-label">
            {scope === 'project' ? 'this project' : 'all projects'}
          </span>
          {scope === 'project' ? ' (Tab to widen)' : ' (Tab to narrow)'}
        </span>
      </div>
    </div>
  )
}
