import { useEffect, useRef, useState } from 'react'
import { canHaveSession, type TabDescriptor, type TabState } from '../shared/ipc'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { cn } from './lib/cn'
import { tabLabel } from './lib/tabLabel'
import { ColorSwatches } from './ColorSwatches'
import { PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'
import type { TabGroupEntry } from './lib/tabGroups'

export function TabBar({
  tabs,
  activeId,
  status,
  since,
  now,
  dead,
  dirty,
  onActivate,
  onClose,
  onRestart,
  onDismiss,
  onNew,
  onRename,
  onRecolor,
  canOpen,
}: {
  tabs: TabGroupEntry[]
  activeId: string | null
  status: Record<string, TabState>
  /** When each tab entered its state, epoch ms. Absent means no label. */
  since: Record<string, number>
  /** Ticked by `App` on a coarse interval, so this component holds no timer. */
  now: number
  dead: Record<string, number>
  dirty: Record<string, boolean>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onRestart: (tab: TabDescriptor) => void
  onDismiss: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onRecolor: (id: string, color: PaneColor | null) => void
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
  // The trade is that the menu does not follow its tab, so it can end up
  // hanging off the wrong one: a wheel or trackpad swipe scrolls the bar
  // without firing the `click` that closes the menu; ⌘W closes the ACTIVE
  // pane, which a right-click does not make this tab, so closing a tab to the
  // left shifts this one; and a session exiting swaps one button for two on
  // its tab, widening it, on main's schedule rather than on any input. The
  // item still renames the tab it was opened on, because the id travels in
  // this state rather than being read back off the position.
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
    // Seeded from the raw title, not `tabLabel`: opening the field on an
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
      {tabs.map((entry) => {
        const tab = entry.pane
        const active = tab.id === activeId
        // `paneGroups`'s `isDead`, applied to the other surface that offers a
        // restart. The overlay reads `PaneBox.dead` and this bar reads the raw
        // map, so without the kind test here the same tombstone would be
        // refused over the pane and honoured in its tab: one ↻ offering to
        // restart a file. The two are one rule through `canHaveSession`.
        //
        // **No test can fail on the `canHaveSession` half, and that is a fact
        // about `state.dead` rather than a reason to drop it.** Measured while
        // adding it: `state.dead` is written only by the `died` action, which
        // `App.tsx` dispatches from main's pty exit event, and an editor pane
        // has no pty to exit. So nothing reachable through the app can put an
        // editor pane's id in that map, and a mutation of this line changes no
        // observable behaviour. It is kept because one rule in `canHaveSession`
        // beats two rules that agree by coincidence.
        //
        // What would make it reachable, and therefore worth a test: any path
        // that writes `state.dead` from something other than a pane's own exit
        // (a restore that replayed saved tombstones, an id collision between a
        // pane and a tab, a future sessionless kind that CAN fail). If you are
        // adding one of those, this line stops being unfalsifiable and should
        // get a test in the same commit.
        const tombstoned = canHaveSession(tab) && dead[tab.id] !== undefined
        // `dirty` is keyed by PANE id, and so is every row this bar renders,
        // unconditionally rather than only while tabs hold one pane each.
        // `App.tsx` passes `tabsOfProject`, which is a filter over the flat
        // `state.panes` array (`workspace.ts`), so each `tab` here IS a pane
        // and `tab.id` IS its pane id. `tabs.spec.ts` says the same thing in
        // its own words: "A tab here is a pane wearing a tab's name."
        //
        // Which settles what ⌘D on an editor pane will need, since an earlier
        // version of this comment predicted the opposite: a split adds a pane
        // to `state.panes`, so it adds a row of its own here with its own id,
        // exactly as a terminal split does. Nothing has to ask whether ANY pane
        // of a tab is dirty, and this line does not change.
        const unsaved = dirty[tab.id] === true
        return (
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            // The whole grouping signal, carried on the div that is already
            // here rather than a nested element: the e2e suite counts tabs
            // with `[data-testid^="tab-"]`, so a second element per tab under
            // that prefix would inflate every one of those counts.
            data-group-id={entry.groupId ?? undefined}
            data-group-pos={entry.pos ?? undefined}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              // The tab's own box, so the menu still hangs off this tab's left
              // edge and the bar's bottom the way it looks like it does.
              const box = event.currentTarget.getBoundingClientRect()
              setMenu({ id: tab.id, left: box.left, top: box.bottom })
            }}
            // Two insets on two edges that compose rather than replace: the
            // top strip says "these panes are one split" and the bottom line
            // says "this pane is focused", so a grouped active tab shows
            // both. Inline rather than a Tailwind arbitrary value because the
            // list is built from two independent conditions and an arbitrary
            // value holding a comma is not worth the escaping.
            style={{
              boxShadow:
                [
                  entry.pos === null ? null : 'inset 0 2px 0 var(--color-group)',
                  active ? 'inset 0 -1px 0 var(--color-accent)' : null,
                ]
                  .filter((inset): inset is string => inset !== null)
                  .join(', ') || undefined,
            }}
            className={cn(
              'flex cursor-default items-center gap-1.5 whitespace-nowrap px-2.5',
              // Kept on the group's LAST member and on every ungrouped tab, so
              // a split's run of tabs reads as one box. The strip alone is not
              // enough: a divider through the middle of it would say the
              // opposite of what the strip says.
              entry.pos === 'first' || entry.pos === 'middle' ? null : 'border-r border-border',
              active ? 'bg-bg text-fg' : 'text-muted',
            )}
          >
            <StatusDot state={status[tab.id] ?? null} testid={`dot-${tab.id}`} />
            {/* How long this tab has been in its state, on the tab itself but
                only while it is NOT idle. An idle session is not one anybody
                is waiting on, and a duration on every tab in the bar is a row
                of numbers rather than a signal. */}
            {(() => {
              const state = status[tab.id] ?? null
              if (state === null || state === 'idle') return null
              const label = elapsedLabel(since[tab.id] ?? null, now)
              return label === null ? null : (
                <span data-testid={`elapsed-${tab.id}`} className="ml-1 text-faint">
                  {label}
                </span>
              )
            })()}
            {renamingId === tab.id ? (
              <input
                data-testid={`tabinput-${tab.id}`}
                // `App.tsx`'s ⌘ handler returns early inside this, and the
                // comment there records why: ⌘W typed while renaming used to
                // close the tab and kill its session, taking the half-typed
                // name with it. Without this attribute that bug simply moves
                // to tabs.
                data-shortcuts="off"
                aria-label={`Rename ${tabLabel(tab)}`}
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
                className={cn(tombstoned && 'line-through opacity-60')}
              >
                {tabLabel(tab)}
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
                {/* The same row the pane's own right-click menu shows. A tab
                    with one pane IS that pane, and reaching the colour should
                    not depend on which of the two the pointer was over. */}
                <ColorSwatches
                  paneId={tab.id}
                  selected={tab.color ?? PANE_COLOR_DEFAULT}
                  onPick={(color) => {
                    setMenu(null)
                    onRecolor(tab.id, color)
                  }}
                />
              </div>
            ) : null}
            {unsaved && (
              <span
                data-testid={`editor-dirty-${tab.id}`}
                title="Unsaved changes"
                className="mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-fg"
              />
            )}
            {tombstoned ? (
              <>
                {/* A dead tab keeps its scrollback and offers the two things
                    worth doing with it. Restart recreates the session under
                    the same id, cwd, command and type. */}
                <button
                  data-testid={`restart-${tab.id}`}
                  aria-label={`Restart ${tabLabel(tab)}`}
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
                  aria-label={`Dismiss ${tabLabel(tab)}`}
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
                aria-label={`Close ${tabLabel(tab)}`}
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
