import { useCallback, useEffect, useRef, useState } from 'react'
import type { IssueRepo, IssueStateFilter, IssueSummary, IssuesFailure, ProjectDescriptor } from '../shared/ipc'
import { filterIssues, shouldRefetchOnFocus, sortIssues, type IssueSort } from './lib/issueList'
import { historyAgo } from './lib/historyAgo'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'
import { IssueModal } from './IssueModal'

const SORT_ORDER: IssueSort[] = ['updated', 'newest', 'comments']
const SORT_LABEL: Record<IssueSort, string> = { updated: 'Updated', newest: 'Newest', comments: 'Comments' }

function nextSort(current: IssueSort): IssueSort {
  return SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length]
}

/**
 * What one `issuesList` reply left the column showing, stamped with the
 * project and filter it was actually fetched under.
 *
 * The stamp is the whole point. A fetch takes as long as `gh` takes (seconds
 * on a busy repository), and the column deliberately keeps the previous
 * reply on screen while the next one is in flight rather than blanking. Held
 * as loose `rows`/`repo`/`state` that pairs with whatever the live filter and
 * project happen to be, that produces two different lies: a count and label
 * from a filter the server was never asked about, and rows belonging to a
 * project the user has already left, whose numbers a click or a quick-close
 * would then apply to the project they switched TO. Keeping the target
 * alongside the payload means the render can simply refuse to pair them.
 */
type Result =
  | {
      ok: true
      projectId: string
      state: IssueStateFilter
      rows: IssueSummary[]
      repo: IssueRepo
      truncated: boolean
    }
  | { ok: false; projectId: string; reason: IssuesFailure; message: string }

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

function Row({
  row,
  now,
  onSelect,
  onQuickClose,
}: {
  row: IssueSummary
  now: number
  onSelect: (number: number) => void
  /** Undefined for a closed row: quick-close only ever closes an open issue. */
  onQuickClose?: (number: number) => void
}) {
  const updatedSeconds = Math.floor(new Date(row.updatedAt).getTime() / 1000)
  return (
    // `group` for the quick-close button's hover reveal, the same pattern
    // `GitPanel`'s own row uses for its stage/unstage/discard buttons.
    <div className="group relative flex w-full items-start">
      <button
        data-testid={`issue-row-${row.number}`}
        onClick={() => onSelect(row.number)}
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
      {onQuickClose ? (
        <button
          data-testid={`issue-quick-close-${row.number}`}
          onClick={() => onQuickClose(row.number)}
          title="Close as completed"
          className="absolute right-1 top-1 shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
        >
          ✕
        </button>
      ) : null}
    </div>
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
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<IssueStateFilter>('open')
  const [sort, setSort] = useState<IssueSort>('updated')
  // The issue a row click opened, or null for no modal. Held here rather
  // than inside `IssueModal` itself so a row can set it directly and the
  // modal can hand it back to null on close, the split `SettingsPane`'s
  // caller already uses for its own `open` flag.
  const [open, setOpen] = useState<number | null>(null)
  // The heading's `+`, a second and independent way to open the modal: see
  // `IssueModal`'s own doc comment for why this is not folded into `open`.
  const [creating, setCreating] = useState(false)
  // A quick-close that failed. Cleared at the start of the next attempt and
  // by any list load, the same rule `IssueModal` applies to its own
  // `mutationError`: cleared only by the next quick-close, it outlived the
  // very refresh that proved it fixed, and outlived the project it was about.
  const [quickCloseError, setQuickCloseError] = useState<string | null>(null)

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
    setQuickCloseError(null)
    if (!projectId) {
      setResult(null)
      setLoading(false)
      return
    }
    setLoading(true)
    // `projectId` and `state` are read here, at the moment the call is made,
    // and travel with the reply: by the time it lands either may already have
    // moved on, and the reply describes neither of the new ones.
    window.pterm
      .issuesList(projectId, state)
      .then((reply) => {
        if (requestId.current !== token) return
        lastFetchedAt.current = Date.now()
        setResult(
          reply.ok
            ? {
                ok: true,
                projectId,
                state,
                rows: reply.value,
                repo: reply.repo,
                truncated: reply.truncated,
              }
            : { ok: false, projectId, reason: reply.reason, message: reply.message },
        )
        setLoading(false)
      })
      .catch(() => {
        if (requestId.current !== token) return
        lastFetchedAt.current = Date.now()
        setResult({
          ok: false,
          projectId,
          reason: 'failed',
          message: 'The GitHub CLI reported an error.',
        })
        setLoading(false)
      })
  }, [project?.id, state])

  // Mount (while expanded), project change and state change all fall out of
  // this one effect: `load`'s identity changes exactly when `project?.id` or
  // `state` does, and collapsing/expanding toggles `collapsed` itself. Nothing
  // on screen is cleared here or in `load`: a reply for the SAME project stays
  // up until its replacement arrives, so a refresh or a filter change never
  // blanks the list. A reply for a DIFFERENT project stops being rendered at
  // all, see `current` below.
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

  // The row's hover ✕: close as completed, then refetch. On success the row
  // disappearing from the OPEN filter is the only feedback this needs; on
  // failure it says why, the same rule the modal's own mutations follow,
  // rather than a toast that has come and gone before it is read.
  const quickClose = (number: number): void => {
    const projectId = project?.id
    if (!projectId) return
    setQuickCloseError(null)
    window.pterm
      .issuesSetState(projectId, number, 'close', 'completed')
      .then((result) => {
        if (result.ok) load()
        else setQuickCloseError(result.message)
      })
      .catch(() => setQuickCloseError('The GitHub CLI reported an error.'))
  }

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

  // The one gate between a stored reply and the screen: a reply is rendered
  // only while it still describes the project on screen. Everything below
  // reads `current` rather than `result`, so a switch shows the loading state
  // until the new project's own reply lands, and there is never a row whose
  // number could be sent to a repository it did not come from.
  const current = result !== null && result.projectId === project?.id ? result : null
  const filtered = current?.ok ? sortIssues(filterIssues(current.rows, query), sort) : []
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
      {/* Heading and `+` as siblings, the same layout `PromptsPanel` uses and
          for the same reason: a button inside a button is invalid HTML, and
          the inner click would bubble out and collapse the column. */}
      <div className="flex items-center justify-between pr-2.5">
        <PanelHeading
          testid="issues-toggle"
          label="Issues"
          onClick={onToggle}
          onDragStart={onDragStart}
        />
        {project ? (
          <button
            data-testid="issues-new"
            aria-label="New issue"
            onClick={() => setCreating(true)}
            className="cursor-default border-none bg-transparent p-0 text-[13px] leading-none text-faint hover:text-fg"
          >
            +
          </button>
        ) : null}
      </div>
      {!project ? (
        <p data-testid="issues-no-project" className="px-2.5 py-1 text-faint">
          No project selected.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1 text-faint">
            {current?.ok ? (
              // The slug truncates on its own and the count sits outside it
              // with `shrink-0`. Both inside one truncating span, an ordinary
              // slug filled the row by itself and pushed the count past the
              // clip boundary, so the count disappeared entirely instead of
              // the name shortening: measured 164px of room against 272px of
              // content at the 208px default width.
              <span className="flex min-w-0 items-baseline gap-1">
                <span data-testid="issues-repo" className="truncate text-muted">
                  {current.repo.slug}
                </span>
                {/* Both halves come from `current`, so the number and the word
                    beside it are the ones this row set was actually fetched
                    under. Rendering the count against the LIVE filter instead
                    captioned the previous filter's rows with the new filter's
                    word for the length of the `gh` call. */}
                <span data-testid="issues-count" className="shrink-0">
                  {current.truncated ? '200+' : `${current.rows.length} ${current.state}`}
                </span>
              </span>
            ) : (
              <span />
            )}
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
          {current !== null && !current.ok ? (
            <div data-testid={`issues-empty-${current.reason}`} className="px-2.5 py-2 text-faint">
              <p>{current.message}</p>
              {current.reason === 'no-gh' ? (
                <code className="mt-1 block select-text text-fg">brew install gh</code>
              ) : null}
              {current.reason === 'no-auth' ? (
                <code className="mt-1 block select-text text-fg">gh auth login</code>
              ) : null}
            </div>
          ) : (
            <div data-testid="issues-list" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {current === null ? (
                <p data-testid="issues-loading" className="px-2.5 py-1 text-faint">
                  …
                </p>
              ) : filtered.length === 0 ? (
                <p data-testid="issues-empty-list" className="px-2.5 py-1 text-faint">
                  {query.trim() !== '' ? 'Nothing matches.' : 'No issues.'}
                </p>
              ) : (
                filtered.map((row) => (
                  <Row
                    key={row.number}
                    row={row}
                    now={now}
                    onSelect={setOpen}
                    onQuickClose={row.state === 'OPEN' ? quickClose : undefined}
                  />
                ))
              )}
            </div>
          )}
          {quickCloseError ? (
            <p data-testid="issues-quick-close-error" className="px-2.5 py-1 text-[11px] text-danger">
              {quickCloseError}
            </p>
          ) : null}
          <IssueModal
            projectId={project.id}
            // Only used to name the repository a NEW issue would be filed
            // against: the read and edit modes learn theirs from the reply
            // that fetched the issue, which is the one that cannot disagree
            // with what is on screen.
            projectRepo={current?.ok ? current.repo.slug : null}
            number={open}
            create={creating}
            onClose={() => {
              setOpen(null)
              setCreating(false)
            }}
            onMutated={load}
          />
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
