import { useCallback, useEffect, useState } from 'react'
import type { TodoRecord } from '../shared/ipc'
import {
  filterTodos,
  nextTodoSort,
  sortTodos,
  PRIORITY_DOT,
  SORT_LABEL,
  type TodoPriorityFilter,
  type TodoSort,
  type TodoStateFilter,
} from './lib/todoList'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, PanelSurface, type PanelSide } from './ui/Panel'
import { TodoModal } from './TodoModal'

function StateButton({
  filter,
  active,
  onClick,
}: {
  filter: TodoStateFilter
  active: boolean
  onClick: () => void
}) {
  const label = filter === 'open' ? 'Open' : filter === 'done' ? 'Done' : 'All'
  return (
    <button
      data-testid={`todos-state-${filter}`}
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

function PriorityButton({
  filter,
  active,
  onClick,
}: {
  filter: TodoPriorityFilter
  active: boolean
  onClick: () => void
}) {
  const label = filter === 'all' ? 'All' : filter === 'high' ? 'Hi' : filter === 'medium' ? 'Med' : 'Lo'
  return (
    <button
      data-testid={`todos-priority-${filter}`}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg',
        active && 'text-fg',
      )}
    >
      {filter !== 'all' ? <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[filter])} /> : null}
      {label}
    </button>
  )
}

function Row({
  todo,
  onSelect,
  onToggleDone,
}: {
  todo: TodoRecord
  onSelect: (id: string) => void
  onToggleDone: (id: string, done: boolean) => void
}) {
  return (
    // `group` so the done button below can stay invisible until the row is
    // hovered.
    <div className="group relative flex w-full items-start">
      <button
        data-testid={`todo-row-${todo.id}`}
        onClick={() => onSelect(todo.id)}
        className="flex w-full cursor-default items-baseline gap-1.5 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg"
      >
        <span
          data-testid={`todo-dot-${todo.id}`}
          className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[todo.priority])}
        />
        <span className={cn('truncate', todo.done && 'text-faint line-through')}>{todo.title}</span>
      </button>
      {/*
        Marks DONE, not deleted: a destructive action revealed by hover is one
        mis-click away at all times, so deleting is the modal's job.
      */}
      <button
        data-testid={`todo-done-${todo.id}`}
        onClick={() => onToggleDone(todo.id, !todo.done)}
        title={todo.done ? 'Mark as not done' : 'Mark as done'}
        className="absolute right-1 top-1 shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
      >
        {todo.done ? '↺' : '✓'}
      </button>
    </div>
  )
}

/**
 * The Todos column: a global list with search, a state filter, a priority
 * filter, a sort toggle, and a row per todo.
 *
 * No `project` prop, and that absence is the feature. The list is global,
 * local, and arrives in one round trip, so there is nothing here that stamps a
 * reply with the project and filter it was fetched under: no request token, no
 * focus refetch, and no "no project selected" state to render.
 */
export function TodosPanel({
  collapsed,
  onToggle,
  onDragStart,
  side,
  creating,
  onCreatingChange,
  embedded = false,
}: {
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
  /**
   * Whether the create modal is open. Held by the caller rather than here so
   * something outside this column can open it, which is why the collapsed
   * branch below still renders the dialog.
   */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
  /** Renders beneath Environment in Workspace Light instead of in the row. */
  embedded?: boolean
}) {
  // No `fallback` argument, so this column takes `useColumnWidth`'s own
  // default: what is on screen is a list of short titles, not the prose a note
  // holds.
  const { width, set, commit } = useColumnWidth('pterm:todosWidth')
  // null is "not loaded yet", which is what the `…` row renders. An empty
  // array is a loaded empty list, which renders `No todos.`
  const [todos, setTodos] = useState<TodoRecord[] | null>(null)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<TodoStateFilter>('open')
  const [priority, setPriority] = useState<TodoPriorityFilter>('all')
  const [sort, setSort] = useState<TodoSort>('priority')
  const [open, setOpen] = useState<string | null>(null)
  // A read or a write that failed, shown below the list. Cleared at the start
  // of the next attempt at either and again by `applyMutation` when one
  // succeeds, which is the rule `IssuesPanel`'s own `quickCloseError` follows:
  // an error cleared only by the next failure outlives the refresh that proved
  // it fixed.
  //
  // NOT cleared by the pushed list below. The rule is: a push means SOME
  // window wrote, which says nothing about the write that failed in THIS one.
  // This app is single-window, so today the only push this window ever gets
  // is the echo of its own successful mutation, and `applyMutation` has
  // already cleared the error from that same reply by the time it arrives —
  // the rule currently guards against nothing observable. It is kept because
  // it is the correct rule regardless.
  const [error, setError] = useState<string | null>(null)

  /**
   * What every successful mutation lands on, from this column or from the
   * modal: the new list, and the error cleared.
   *
   * One function rather than a bare `setTodos` at each call site, because the
   * clearing half is what got missed. The modal's reply is the source of the
   * list (it carries the whole thing, so there is nothing to refetch), and
   * without this a stale "Writing the todo list failed." sat over a list that
   * a later modal edit had already put right.
   */
  const applyMutation = useCallback((rows: TodoRecord[]): void => {
    setTodos(rows)
    setError(null)
  }, [])

  const load = useCallback((): void => {
    setError(null)
    window.pterm
      .todosList()
      .then(setTodos)
      // A rejected `todosList` is a call that did not COMPLETE: no handler
      // registered yet, or the main process going away mid-flight. It is not
      // how a damaged file arrives. `readTodos` in `src/main/todos/store.ts`
      // answers a missing or unparseable `todos.json` with an empty list on
      // purpose, so a bad file renders as "No todos." below and never reaches
      // here. Hence the wording: the list could not be reached, not that it
      // could not be read.
      //
      // `todos` is left as it was either way, so a first load that failed
      // keeps it null and nothing below claims the list is empty.
      .catch(() => setError('Could not reach the todo list.'))
  }, [])

  // One fetch on mount plus the push subscription, which is why nothing here
  // polls or listens for window focus: every in-app change comes back as a
  // pushed list. Not gated on `collapsed`, because the read is one local call
  // rather than a network round trip, and the dialog below can be open over a
  // collapsed column.
  useEffect(() => {
    load()
    return window.pterm.onTodosChanged(setTodos)
  }, [load])

  // Built once and rendered by both branches below: `creating` is meaningful
  // whether this column is open or collapsed to its strip, and a `Dialog`
  // portals its content out of whichever one is holding it.
  const modal = (
    <TodoModal
      todo={todos?.find((row) => row.id === open) ?? null}
      create={creating}
      onClose={() => {
        setOpen(null)
        onCreatingChange(false)
      }}
      onChanged={applyMutation}
    />
  )

  if (collapsed) {
    return (
      <>
        <PanelStrip
          testid="todos-toggle"
          label="Todos"
          side={side}
          onClick={onToggle}
          onDragStart={onDragStart}
          embedded={embedded}
        />
        {modal}
      </>
    )
  }

  const rows = todos ?? []
  const visible = sortTodos(filterTodos(rows, { query, state, priority }), sort)
  const openCount = rows.filter((todo) => !todo.done).length

  return (
    <PanelSurface
      data-testid="todos-panel"
      embedded={embedded}
      side={side}
      className={cn(
        'font-mono text-[11px] select-none',
      )}
      style={embedded ? undefined : { width }}
    >
      {/* Heading and `+` as siblings, not nested: a button inside a button is
          invalid HTML, and the inner click would bubble out and collapse the
          column. */}
      <div className="flex items-center justify-between pr-2.5">
        <PanelHeading testid="todos-toggle" label="Todos" onClick={onToggle} onDragStart={onDragStart} />
        <button
          data-testid="todos-new"
          aria-label="New todo"
          onClick={() => onCreatingChange(true)}
          className="cursor-default border-none bg-transparent p-0 text-[13px] leading-none text-faint hover:text-fg"
        >
          +
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 pb-1 text-faint">
        <span data-testid="todos-count" className="shrink-0">
          {todos === null ? '' : `${openCount} open`}
        </span>
        {/* Re-runs the same read the mount does. Every in-app edit arrives on
            its own, so this is here for a list changed outside the app. */}
        <button
          data-testid="todos-refresh"
          onClick={load}
          title="Refresh"
          className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint hover:text-fg"
        >
          ↻
        </button>
      </div>
      <input
        data-testid="todos-search"
        // Load-bearing, same as every text field in this app: without it ⌘W
        // typed while searching closes a pane and destroys its session.
        data-shortcuts="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search todos"
        spellCheck={false}
        className="mx-2.5 mb-1 border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
      />
      <div className="flex items-center justify-between gap-1 px-2 pb-1">
        <div className="flex items-center gap-1">
          <StateButton filter="open" active={state === 'open'} onClick={() => setState('open')} />
          <StateButton filter="done" active={state === 'done'} onClick={() => setState('done')} />
          <StateButton filter="all" active={state === 'all'} onClick={() => setState('all')} />
        </div>
        <button
          data-testid="todos-sort"
          onClick={() => setSort(nextTodoSort(sort))}
          title="Change sort"
          className="cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg"
        >
          {SORT_LABEL[sort]}
        </button>
      </div>
      <div className="flex items-center gap-0.5 px-2 pb-1.5">
        <PriorityButton filter="all" active={priority === 'all'} onClick={() => setPriority('all')} />
        <PriorityButton filter="high" active={priority === 'high'} onClick={() => setPriority('high')} />
        <PriorityButton filter="medium" active={priority === 'medium'} onClick={() => setPriority('medium')} />
        <PriorityButton filter="low" active={priority === 'low'} onClick={() => setPriority('low')} />
      </div>
      <div data-testid="todos-list" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {todos === null ? (
          // No `…` while an error is up: that row means a load is still
          // running, and the message below has already said one finished and
          // failed.
          error === null ? (
            <p data-testid="todos-loading" className="px-2.5 py-1 text-faint">
              …
            </p>
          ) : null
        ) : visible.length === 0 ? (
          <p data-testid="todos-empty-list" className="px-2.5 py-1 text-faint">
            {rows.length === 0 ? 'No todos.' : 'Nothing matches.'}
          </p>
        ) : (
          visible.map((todo) => (
            <Row
              key={todo.id}
              todo={todo}
              onSelect={setOpen}
              onToggleDone={(id, done) => {
                setError(null)
                // The reply carries the new list, so nothing here has to
                // refetch. On failure the row stays exactly as it was, and the
                // message below is the only feedback there is: the row not
                // moving looks identical to a click that never landed.
                window.pterm
                  .todosSetDone(id, done)
                  .then(applyMutation)
                  .catch(() => setError('Writing the todo list failed.'))
              }}
            />
          ))
        )}
      </div>
      {error !== null ? (
        <p data-testid="todos-error" className="px-2.5 py-1 text-[11px] text-danger">
          {error}
        </p>
      ) : null}
      {modal}
      {!embedded ? (
        <ColumnResizer testid="resize-todos" side={side} width={width} onResize={set} onCommit={commit} />
      ) : null}
    </PanelSurface>
  )
}
