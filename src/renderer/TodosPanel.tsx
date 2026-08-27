import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Check, Plus, RefreshCw, RotateCcw } from 'lucide-react'
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
        'h-7 cursor-default rounded-md px-2 text-xs font-medium text-muted hover:bg-secondary hover:text-fg',
        active && 'bg-secondary text-fg shadow-sm',
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
        'flex h-7 cursor-default items-center gap-1 rounded-md px-2 text-xs font-medium text-muted hover:bg-secondary hover:text-fg',
        active && 'bg-secondary text-fg shadow-sm',
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
    <div className="group relative mx-2 flex items-start rounded-md hover:bg-secondary">
      <button
        data-testid={`todo-row-${todo.id}`}
        onClick={() => onSelect(todo.id)}
        className="flex w-full cursor-default items-baseline gap-1.5 border-none bg-transparent px-2 py-2 text-left text-muted hover:text-fg"
      >
        <span
          data-testid={`todo-dot-${todo.id}`}
          className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[todo.priority])}
        />
        <span className={cn('truncate font-medium text-fg', todo.done && 'text-faint line-through')}>{todo.title}</span>
      </button>
      {/*
        Marks DONE, not deleted: a destructive action revealed by hover is one
        mis-click away at all times, so deleting is the modal's job.
      */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid={`todo-done-${todo.id}`}
        onClick={() => onToggleDone(todo.id, !todo.done)}
        title={todo.done ? 'Mark as not done' : 'Mark as done'}
        className="absolute right-1 top-1 cursor-default text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
      >
        {todo.done ? <RotateCcw /> : <Check />}
      </Button>
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
        'select-none',
      )}
      style={embedded ? undefined : { width }}
    >
      {/* Heading and `+` as siblings, not nested: a button inside a button is
          invalid HTML, and the inner click would bubble out and collapse the
          column. */}
      <div className="flex items-center justify-between pr-2.5">
        <PanelHeading testid="todos-toggle" label="Todos" onClick={onToggle} onDragStart={onDragStart} />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todos-new"
          aria-label="New todo"
          onClick={() => onCreatingChange(true)}
          className="mr-1.5 cursor-default text-muted hover:text-fg"
        >
          <Plus />
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 pb-2 text-xs text-faint">
        <span data-testid="todos-count" className="shrink-0">
          {todos === null ? '' : `${openCount} open`}
        </span>
        {/* Re-runs the same read the mount does. Every in-app edit arrives on
            its own, so this is here for a list changed outside the app. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todos-refresh"
          onClick={load}
          title="Refresh"
          className="cursor-default text-muted hover:text-fg"
        >
          <RefreshCw />
        </Button>
      </div>
      <Input
        data-testid="todos-search"
        // Load-bearing, same as every text field in this app: without it ⌘W
        // typed while searching closes a pane and destroys its session.
        data-shortcuts="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search todos"
        spellCheck={false}
        className="mx-3 mb-2 h-8 w-[calc(100%-1.5rem)] border-border bg-background px-2 text-[13px] text-fg placeholder:text-faint"
      />
      <div className="flex items-center justify-between gap-1 px-3 pb-1.5">
        <div className="flex items-center gap-1 rounded-lg bg-secondary p-0.5">
          <StateButton filter="open" active={state === 'open'} onClick={() => setState('open')} />
          <StateButton filter="done" active={state === 'done'} onClick={() => setState('done')} />
          <StateButton filter="all" active={state === 'all'} onClick={() => setState('all')} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="todos-sort"
          onClick={() => setSort(nextTodoSort(sort))}
          title="Change sort"
          className="cursor-default text-muted hover:text-fg"
        >
          {SORT_LABEL[sort]}
        </Button>
      </div>
      <div className="mx-3 mb-2 flex w-fit items-center gap-0.5 rounded-lg bg-secondary p-0.5">
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
