import { useCallback, useEffect, useRef, useState } from 'react'
import type { IssueRepo, IssueStateFilter, IssueSummary, IssuesFailure, ProjectDescriptor } from '../shared/ipc'
import { filterIssues, shouldRefetchOnFocus, sortIssues, type IssueSort } from './lib/issueList'
import { historyAgo } from './lib/historyAgo'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'

const SORT_ORDER: IssueSort[] = ['updated', 'newest', 'comments']
const SORT_LABEL: Record<IssueSort, string> = { updated: 'Updated', newest: 'Newest', comments: 'Comments' }

function nextSort(current: IssueSort): IssueSort {
  return SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length]
}

/** What a failed `issuesList` left the column showing. */
type Failure = { reason: IssuesFailure; message: string }

function StateButton({
  filter,
  active,
  onClick,
}: {
  filter: IssueStateFilter
  active: boolean
  onClick: () => void
}) {
  const label = filter === 'open' ? 'Open' : filter === 'closed' ? 'Closed' : 'All'
  return (
    <button
      data-testid={`issues-state-${filter}`}
      onClick={onClick}
      className={cn(
        'cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg',
        active && 'text-fg',
      )}
    >
      {label}
    </button>
  )
}

function Row({ row, now }: { row: IssueSummary; now: number }) {
  const updatedSeconds = Math.floor(new Date(row.updatedAt).getTime() / 1000)
  return (
    <button
      data-testid={`issue-row-${row.number}`}
      className="flex w-full cursor-default flex-col items-start gap-0.5 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg"
    >
      <span className="flex w-full items-baseline gap-1.5">
        <span className="shrink-0 text-faint">#{row.number}</span>
        <span className="truncate">{row.title}</span>
      </span>
      <span className="flex w-full items-center gap-1.5 text-faint">
        <span className="shrink-0">{historyAgo(updatedSeconds, now)}</span>
        <span className="shrink-0">
          {row.commentCount} {row.commentCount === 1 ? 'comment' : 'comments'}
        </span>
        {row.labels.length > 0 ? (
          <span className="flex items-center gap-1">
            {row.labels.map((label) => (
              <span
                key={label.name}
                title={label.name}
                style={{ backgroundColor: `#${label.color}` }}
                className="h-1.5 w-1.5 shrink-0 rounded-full"
              />
            ))}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/**
 * The Issues column's list: search, state filter, sort, and a row per issue,
 * with a dedicated empty state per `IssuesFailure`.
 */
export function IssuesPanel({
  project,
  collapsed,
  onToggle,
  onDragStart,
  side,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
}) {
  // 208, not the 256 `NotesPanel` uses: that width is justified there because
  // a note is prose. This column is a list of short titles, the same shape as
  // Git, Skills, Presets and Files, all of which take the 208 default.
  const { width, set, commit } = useColumnWidth('pterm:issuesWidth')
  const [rows, setRows] = useState<IssueSummary[] | null>(null)
  const [repo, setRepo] = useState<IssueRepo | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<IssueStateFilter>('open')
  const [sort, setSort] = useState<IssueSort>('updated')

  // `load` has several callers (the effect below, the focus listener, the
  // refresh button), unlike `NotesPanel`'s single fetch site, so a closured
  // `cancelled` boolean cannot be shared between them. A token ref generalises
  // the same idea: each call captures the counter's value at the moment it
  // started, and a reply only lands if nothing newer has started since:
  // project switch, state change, and a second click of refresh all invalidate
  // whatever was already in flight the same way.
  const requestId = useRef(0)
  const lastFetchedAt = useRef<number | null>(null)

  const load = useCallback((): void => {
    const projectId = project?.id
    const token = ++requestId.current
    if (!projectId) {
      setRows(null)
      setRepo(null)
      setTruncated(false)
      setFailure(null)
      setLoading(false)
      return
    }
    setLoading(true)
    window.pterm
      .issuesList(projectId, state)
      .then((result) => {
        if (requestId.current !== token) return
        lastFetchedAt.current = Date.now()
        if (result.ok) {
          setRepo(result.repo)
          setRows(result.value)
          setTruncated(result.truncated)
          setFailure(null)
        } else {
          setRepo(null)
          setRows(null)
          setTruncated(false)
          setFailure({ reason: result.reason, message: result.message })
        }
        setLoading(false)
      })
      .catch(() => {
        if (requestId.current !== token) return
        lastFetchedAt.current = Date.now()
        setRepo(null)
        setRows(null)
        setTruncated(false)
        setFailure({ reason: 'failed', message: 'The GitHub CLI reported an error.' })
        setLoading(false)
      })
  }, [project?.id, state])

  // Mount (while expanded), project change and state change all fall out of
  // this one effect: `load`'s identity changes exactly when `project?.id` or
  // `state` does, and collapsing/expanding toggles `collapsed` itself. Rows
  // already on screen are left alone here, see `load`, which never clears
  // them before a fetch lands, so this never blanks the list it is
  // refreshing.
  useEffect(() => {
    if (collapsed) return
    load()
  }, [collapsed, load])

  // Throttled separately from `load` itself, so every OTHER caller (mount,
  // project switch, state change, the refresh button) still runs on demand.
  useEffect(() => {
    if (collapsed) return
    const onFocus = (): void => {
      if (shouldRefetchOnFocus(lastFetchedAt.current, Date.now())) load()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [collapsed, load])

  if (collapsed) {
    return (
      <PanelStrip
        testid="issues-toggle"
        label="Issues"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  const filtered = rows === null ? [] : sortIssues(filterIssues(rows, query), sort)
  const now = Date.now()

  return (
    <div
      data-testid="issues-panel"
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-surface font-mono text-[11px] select-none',
        // The seam faces the terminal either way, the same rule every panel
        // container in this row follows: a left column drawing `border-l`
        // would put its only border against the window frame.
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      <PanelHeading
        testid="issues-toggle"
        label="Issues"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      {!project ? (
        <p data-testid="issues-no-project" className="px-2.5 py-1 text-faint">
          No project selected.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1 text-faint">
            <span className="truncate">
              {repo ? (
                <>
                  <span data-testid="issues-repo" className="text-muted">
                    {repo.slug}
                  </span>{' '}
                  {/* The count is templated on `state` rather than the literal
                      word "open": a reader on the Closed filter is shown how
                      many CLOSED issues there are, not a stale "open" label
                      left over from the default. */}
                  <span data-testid="issues-count">
                    {truncated ? '200+' : `${rows?.length ?? 0} ${state}`}
                  </span>
                </>
              ) : null}
            </span>
            <button
              data-testid="issues-refresh"
              disabled={loading}
              onClick={() => load()}
              title="Refresh"
              className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint hover:text-fg disabled:opacity-40"
            >
              ↻
            </button>
          </div>
          <input
            data-testid="issues-search"
            // Load-bearing, same as every text field in this app: without it
            // ⌘W typed while searching closes a pane and destroys its session.
            data-shortcuts="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search issues"
            spellCheck={false}
            className="mx-2.5 mb-1 border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
          />
          <div className="flex items-center justify-between gap-1 px-2 pb-1.5">
            <div className="flex items-center gap-1">
              <StateButton filter="open" active={state === 'open'} onClick={() => setState('open')} />
              <StateButton filter="closed" active={state === 'closed'} onClick={() => setState('closed')} />
              <StateButton filter="all" active={state === 'all'} onClick={() => setState('all')} />
            </div>
            <button
              data-testid="issues-sort"
              onClick={() => setSort(nextSort(sort))}
              title="Change sort"
              className="cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg"
            >
              {SORT_LABEL[sort]}
            </button>
          </div>
          {failure ? (
            <div data-testid={`issues-empty-${failure.reason}`} className="px-2.5 py-2 text-faint">
              <p>{failure.message}</p>
              {failure.reason === 'no-gh' ? (
                <code className="mt-1 block select-text text-fg">brew install gh</code>
              ) : null}
              {failure.reason === 'no-auth' ? (
                <code className="mt-1 block select-text text-fg">gh auth login</code>
              ) : null}
            </div>
          ) : (
            <div data-testid="issues-list" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {rows === null ? (
                <p data-testid="issues-loading" className="px-2.5 py-1 text-faint">
                  …
                </p>
              ) : filtered.length === 0 ? (
                <p data-testid="issues-empty-list" className="px-2.5 py-1 text-faint">
                  {query.trim() !== '' ? 'Nothing matches.' : 'No issues.'}
                </p>
              ) : (
                filtered.map((row) => <Row key={row.number} row={row} now={now} />)
              )}
            </div>
          )}
        </>
      )}
      <ColumnResizer
        testid="resize-issues"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
