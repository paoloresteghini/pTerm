import { useEffect, useRef, useState } from 'react'
import type { TabDescriptor, TabState } from '../shared/ipc'
import { StatusDot } from './StatusDot'
import { cn } from './lib/cn'
import { labelOfPane } from './workspace'

export function TabBar({
  tabs,
  activeId,
  status,
  dead,
  onActivate,
  onClose,
  onRestart,
  onDismiss,
  onNew,
  onRename,
  canOpen,
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  status: Record<string, TabState>
  dead: Record<string, number>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onRestart: (tab: TabDescriptor) => void
  onDismiss: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  canOpen: boolean
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Which edit is still open, readable synchronously so that whichever of the
  // two commit paths arrives second is a no-op. Enter and Escape both unmount
  // the input, which today's Chromium does not follow with a blur — but the
  // handlers must not depend on that to avoid committing twice, or committing
  // what Escape discarded. Mirrors Sidebar's project rename.
  const editing = useRef<string | null>(null)

  const startRename = (tab: TabDescriptor): void => {
    editing.current = tab.id
    // Seeded from the raw title, not `labelOfPane`: opening the field on an
    // unnamed tab should offer an empty box, not the slug and id to delete
    // first.
    setDraft(tab.title ?? '')
    setRenamingId(tab.id)
  }

  const finishRename = (id: string, commit: boolean): void => {
    if (editing.current !== id) return
    editing.current = null
    setRenamingId(null)
    // No non-empty guard, unlike the project rename this copies: a blank name
    // is how a tab's name is removed, and a tab has a default to fall back to
    // where a project does not.
    if (commit) onRename(id, draft.trim())
  }

  // Closes the context menu on a click anywhere else. The menu's own item
  // stops propagation before this can see the click, so it only ever fires
  // for a click outside.
  useEffect(() => {
    if (menuFor === null) return
    const closeMenu = (): void => setMenuFor(null)
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [menuFor])

  return (
    <div
      data-testid="tabbar"
      className="flex h-8 select-none items-stretch overflow-x-auto border-b border-border bg-surface font-mono text-[11px]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuFor(tab.id)
            }}
            className={cn(
              'relative flex cursor-default items-center gap-1.5 whitespace-nowrap border-r border-border px-2.5',
              active ? 'bg-bg text-fg shadow-[inset_0_-1px_0_var(--color-accent)]' : 'text-muted',
            )}
          >
            <StatusDot state={status[tab.id] ?? null} testid={`dot-${tab.id}`} />
            {renamingId === tab.id ? (
              <input
                data-testid={`tab-rename-input-${tab.id}`}
                // `App.tsx`'s ⌘ handler returns early inside this, and the
                // comment there records why: ⌘W typed while renaming used to
                // close the tab and kill its session, taking the half-typed
                // name with it. Without this attribute that bug simply moves
                // to tabs.
                data-shortcuts="off"
                aria-label={`Rename ${labelOfPane(tab)}`}
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => finishRename(tab.id, true)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishRename(tab.id, true)
                  if (event.key === 'Escape') finishRename(tab.id, false)
                }}
                // Stops the click that lands in the field from also
                // re-activating the tab underneath it.
                onClick={(event) => event.stopPropagation()}
                className="min-w-0 flex-1 border border-border bg-bg px-1 text-fg outline-none"
              />
            ) : (
              <span
                data-testid={`tab-label-${tab.id}`}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  startRename(tab)
                }}
                className={cn(dead[tab.id] !== undefined && 'line-through opacity-60')}
              >
                {labelOfPane(tab)}
              </span>
            )}
            {menuFor === tab.id ? (
              <div
                data-testid={`tabmenu-${tab.id}`}
                className="absolute left-0 top-8 z-10 flex flex-col border border-border bg-bg py-0.5 text-[11px]"
              >
                <button
                  data-testid={`trename-${tab.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuFor(null)
                    startRename(tab)
                  }}
                  className="cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg"
                >
                  Rename…
                </button>
              </div>
            ) : null}
            {dead[tab.id] !== undefined ? (
              <>
                {/* A dead tab keeps its scrollback and offers the two things
                    worth doing with it. Restart recreates the session under
                    the same id, cwd, command and type. */}
                <button
                  data-testid={`restart-${tab.id}`}
                  aria-label={`Restart ${labelOfPane(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRestart(tab)
                  }}
                  className="cursor-default border-none bg-transparent p-0 text-[10px] text-muted hover:text-fg"
                >
                  ↻
                </button>
                <button
                  data-testid={`dismiss-${tab.id}`}
                  aria-label={`Dismiss ${labelOfPane(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDismiss(tab.id)
                  }}
                  className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-muted hover:text-fg"
                >
                  ×
                </button>
              </>
            ) : (
              // The close button stays exactly as it was for a live tab —
              // closing kills, and killing a dead session has nothing to do.
              <button
                data-testid={`close-${tab.id}`}
                aria-label={`Close ${labelOfPane(tab)}`}
                onClick={(event) => {
                  // Without this the click also activates the tab being closed.
                  event.stopPropagation()
                  onClose(tab.id)
                }}
                className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-inherit"
              >
                ×
              </button>
            )}
          </div>
        )
      })}
      <button
        data-testid="new-tab"
        aria-label="New terminal"
        onClick={onNew}
        disabled={!canOpen}
        className="cursor-default border-none bg-transparent px-3 text-sm text-faint disabled:opacity-40 enabled:hover:text-muted"
      >
        +
      </button>
    </div>
  )
}
