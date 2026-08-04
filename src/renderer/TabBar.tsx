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
  // The open menu, with the viewport coordinates it is drawn at.
  //
  // Coordinates, rather than the `absolute left-0 top-8` this used to be,
  // because the bar is `overflow-x-auto` and per CSS a box with one overflow
  // axis not `visible` computes the other to `auto` too, so the bar clips
  // vertically at its own 32px, and a menu starting at the bar's bottom edge
  // is clipped away entirely. Measured in the built app, 2026-08-03: bar
  // 38..70, menu 70..100.5, height of the menu visible inside the bar 0px,
  // and `elementFromPoint` at both the menu's centre and the Rename… item's
  // centre returning the terminal's `.xterm-screen`, not the menu. The e2e
  // could not see it because Playwright scrolls the nearest scrollable
  // ancestor before clicking, which a user cannot.
  //
  // `position: fixed` is the smallest thing that works: it takes the viewport
  // as its containing block, so no ancestor's overflow clips it, and it needs
  // no portal, no ref and no second element outside the scroller. Sidebar's
  // menu is in flow inside a vertically scrolling list and has none of this
  // problem, so there was no pattern here to copy.
  //
  // The trade is that the menu does not follow the bar if the bar is scrolled
  // under it. It cannot be: any click closes the menu, and the bar has no
  // other way to scroll while one is open.
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Which edit is still open, readable synchronously so that whichever of the
  // two commit paths arrives second is a no-op. Enter and Escape both unmount
  // the input, and today's Chromium does not reliably follow that with a
  // blur: the handlers must not depend on that to avoid committing twice, or
  // committing what Escape discarded. Mirrors Sidebar's project rename.
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
    if (menu === null) return
    const closeMenu = (): void => setMenu(null)
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [menu])

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
              // The tab's own box, so the menu still hangs off this tab's left
              // edge and the bar's bottom the way it looks like it does.
              const box = event.currentTarget.getBoundingClientRect()
              setMenu({ id: tab.id, left: box.left, top: box.bottom })
            }}
            className={cn(
              'flex cursor-default items-center gap-1.5 whitespace-nowrap border-r border-border px-2.5',
              active ? 'bg-bg text-fg shadow-[inset_0_-1px_0_var(--color-accent)]' : 'text-muted',
            )}
          >
            <StatusDot state={status[tab.id] ?? null} testid={`dot-${tab.id}`} />
            {renamingId === tab.id ? (
              <input
                data-testid={`tabinput-${tab.id}`}
                // `App.tsx`'s ⌘ handler returns early inside this, and the
                // comment there records why: ⌘W typed while renaming used to
                // close the tab and kill its session, taking the half-typed
                // name with it. Without this attribute that bug simply moves
                // to tabs.
                data-shortcuts="off"
                aria-label={`Rename ${labelOfPane(tab)}`}
                autoFocus
                // Selected, not just focused: renaming an already-named tab
                // is usually replacing the name, and a bare caret makes the
                // user clear the old one by hand first. Sidebar's project
                // rename does the same.
                onFocus={(event) => event.target.select()}
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
                // Not `tab-label-`: the e2e suite counts tabs with a
                // `data-testid^="tab-"` prefix match, so a second element per
                // tab under that prefix would inflate every count it takes.
                data-testid={`tablabel-${tab.id}`}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  startRename(tab)
                }}
                className={cn(dead[tab.id] !== undefined && 'line-through opacity-60')}
              >
                {labelOfPane(tab)}
              </span>
            )}
            {menu?.id === tab.id ? (
              <div
                data-testid={`tabmenu-${tab.id}`}
                // Without this, a click on the menu's own padding (not on
                // the button) bubbles to the tab container and activates it.
                onClick={(event) => event.stopPropagation()}
                style={{ left: menu.left, top: menu.top }}
                className="fixed z-20 flex flex-col border border-border bg-bg py-0.5 text-[11px]"
              >
                <button
                  data-testid={`trename-${tab.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenu(null)
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
