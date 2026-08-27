import { useEffect, useRef, useState } from 'react'
import { canHaveSession, type TabDescriptor, type TabState } from '../shared/ipc'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { cn } from './lib/cn'
import { tabLabel } from './lib/tabLabel'
import { usePaneDragDrop } from './lib/usePaneDragDrop'
import { ColorSwatches } from './ColorSwatches'
import { PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'
import type { TabGroupEntry } from './lib/tabGroups'
import { BrowserWindowIcon } from './ui/BrowserWindowIcon'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Plus, RotateCcw, X } from 'lucide-react'

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
  onJoin,
  canJoin,
  canOpen,
  onOpenBrowser,
  canOpenBrowser = true,
  testIdPrefix = 'tab',
  capabilities,
  newLabel = 'New terminal',
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
  /** Drag one tab onto another to merge them into a split. Matches `TabsPanel`'s prop of the same name. */
  onJoin: (paneId: string, targetPaneId: string) => void
  /** Whether dragging `paneId` onto `targetPaneId` would do anything. Matches `TabsPanel`'s prop of the same name. */
  canJoin: (paneId: string, targetPaneId: string) => boolean
  canOpen: boolean
  /**
   * Opens a browser pane on the project's dev server. Optional, and the button
   * is rendered only where it is given, which is how one bar can offer it and
   * another not: this component is shared, and the button belongs beside the
   * terminals whose output is where a dev server announces itself. Which bars
   * pass it is deliberately not written down here, that being the kind of
   * sentence that goes stale silently; `grep -rn '<TabBar' src/` lists every
   * bar this draws.
   */
  onOpenBrowser?: () => void
  /**
   * Whether that button has anything to act on. Read only where
   * `onOpenBrowser` is given, and defaulted to on the way `capabilities` below
   * is: a caller that passes the handler and nothing else means the button to
   * work.
   */
  canOpenBrowser?: boolean
  /**
   * Distinguishes one bar's testids from another's when a second `TabBar`
   * is on screen. Defaults to `'tab'`, which reproduces today's ids
   * (`tabbar`, `tab-${id}`, `new-tab`) exactly. The e2e suite counts terminal
   * tabs with `[data-testid^="tab-"]` in dozens of places, and a second bar
   * rendered under the same prefix would inflate every one of those counts, so
   * a caller adding a second bar must pass a different prefix. Neither an
   * exact number nor a share of the suite is written here, on purpose: the
   * count this comment used to carry (69, across 12 files) was falsified by
   * the very commit that added the second bar, because the spec it added uses
   * the locator too, and the qualifier that replaced it ("most of the spec
   * files") was wrong in its own way. Count them when you need to, with
   * `grep -rn 'data-testid\^="tab-"' tests/e2e/ | wc -l`. `elapsed-` and
   * `tabinput-` are keyed by pane id instead, which is already unique across
   * any number of bars, so they take no prefix and cannot collide.
   */
  testIdPrefix?: string
  /**
   * Which of restart, dismiss and join this bar offers. Omitted (or any
   * key omitted) means on, matching today's only caller. Exists for a
   * sessionless pane, such as a browser tab, which cannot die, so cannot
   * be restarted or dismissed, and has nothing for another tab to join.
   */
  capabilities?: { restart?: boolean; dismiss?: boolean; join?: boolean }
  /**
   * The accessible name of the `+` button, which is the one label on this bar
   * that names what a new tab of it would be. Defaults to the terminal bar's.
   */
  newLabel?: string
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

  // Disabling join means no pane here is ever a valid drop target: passing a
  // `canJoin` that always refuses leaves `over` permanently null, so neither
  // the drop highlight nor the drop itself can fire, without touching
  // `usePaneDragDrop` itself.
  const joinAllowed = capabilities?.join !== false
  const drag = usePaneDragDrop(joinAllowed ? canJoin : () => false, onJoin)

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
    <Tabs
      value={activeId ?? undefined}
      onValueChange={onActivate}
      data-testid={`${testIdPrefix}bar`}
      className="h-10 min-w-0 select-none border-b border-border bg-background px-2"
    >
      <TabsList
        className="mt-1 h-8 w-full min-w-0 justify-start gap-1 overflow-hidden rounded-lg bg-secondary px-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden">
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
        // `App.tsx` passes `tabEntries`, `groupedTabs`' output over the flat
        // `state.panes` array (`workspace.ts`) reordered into groups — one
        // entry per pane either way — so each `tab` here IS a pane and
        // `tab.id` IS its pane id. `tabs.spec.ts` says the same thing in its
        // own words: "A tab here is a pane wearing a tab's name."
        //
        // Which settles what ⌘D on an editor pane will need, since an earlier
        // version of this comment predicted the opposite: a split adds a pane
        // to `state.panes`, so it adds a row of its own here with its own id,
        // exactly as a terminal split does. Nothing has to ask whether ANY pane
        // of a tab is dirty, and this line does not change.
        const unsaved = dirty[tab.id] === true
        return (
          <TabsTrigger
            asChild
            value={tab.id}
            className="w-auto flex-none shrink-0 cursor-default px-3 text-[13px]"
          >
          <div
            key={tab.id}
            data-testid={`${testIdPrefix}-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            // The whole grouping signal, carried on the div that is already
            // here rather than a nested element: the e2e suite counts tabs
            // with `[data-testid^="tab-"]`, so a second element per tab
            // under that prefix (or a second bar defaulting `testIdPrefix`
            // to `'tab'`) would inflate every one of those counts.
            //
            // Gated on `pos`, not just `entry.groupId`: `restore.ts` files
            // every pane under a row after a relaunch, including one-pane
            // rows, so `groupId` is non-null for an ungrouped tab too — only
            // `pos` says whether there is actually a split to frame.
            data-group-id={entry.pos !== null ? (entry.groupId ?? undefined) : undefined}
            data-group-pos={entry.pos ?? undefined}
            data-over={drag.over === tab.id || undefined}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              // The tab's own box, so the menu still hangs off this tab's left
              // edge and the bar's bottom the way it looks like it does.
              const box = event.currentTarget.getBoundingClientRect()
              setMenu({ id: tab.id, left: box.left, top: box.bottom })
            }}
            // Insets on the box's edges that compose rather than replace: the
            // top strip says "these panes are one split", the bottom line
            // says "this pane is focused", and the drag ring says "dropping
            // here joins the tabs", so a grouped active tab under a drag
            // shows all three. Inline rather than a Tailwind arbitrary value
            // because the list is built from independent conditions and an
            // arbitrary value holding commas is not worth the escaping.
            style={{
              boxShadow:
                [
                  entry.pos === null ? null : 'inset 0 2px 0 var(--color-group)',
                  drag.over === tab.id ? 'inset 0 0 0 1px var(--color-accent)' : null,
                ]
                  .filter((inset): inset is string => inset !== null)
                  .join(', ') || undefined,
            }}
            {...drag.propsFor(tab.id)}
            // After the spread, deliberately. `propsFor` hands back a fixed
            // `draggable: true`, and joining is the only thing a dragged tab
            // can do: `application/x-pterm-pane` has no other reader in the
            // renderer, and the Sidebar takes no drop at all. So on a bar
            // with join off, the drag could only ever end where it started,
            // after showing a ghost that says otherwise.
            draggable={joinAllowed}
            className={cn(
              'cursor-default',
              // Kept on the group's LAST member and on every ungrouped tab, so
              // a split's run of tabs reads as one box. The strip alone is not
              // enough: a divider through the middle of it would say the
              // opposite of what the strip says.
              entry.pos === 'first' || entry.pos === 'middle' ? null : 'border-r border-border/60',
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
                className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-foreground outline-none"
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
                className="fixed z-20 flex min-w-36 flex-col rounded-md border border-input bg-popover p-1 text-sm text-popover-foreground shadow-md"
              >
                <button
                  data-testid={`trename-${tab.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenu(null)
                    startRename(tab)
                  }}
                  className="cursor-default rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
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
                    the same id, cwd, command and type. Both gated on
                    `capabilities`, off for a sessionless pane that cannot
                    die and so never reaches `tombstoned` in the first
                    place: this is a second, explicit refusal rather than
                    reliance on that coincidence. */}
                {capabilities?.restart !== false ? (
                  <button
                    data-testid={`restart-${tab.id}`}
                    aria-label={`Restart ${tabLabel(tab)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRestart(tab)
                    }}
                    className="cursor-default rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                ) : null}
                {capabilities?.dismiss !== false ? (
                  <button
                    data-testid={`dismiss-${tab.id}`}
                    aria-label={`Dismiss ${tabLabel(tab)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDismiss(tab.id)
                    }}
                    className="cursor-default rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
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
                className="cursor-default rounded-sm p-0.5 text-inherit hover:bg-accent"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          </TabsTrigger>
        )
        })}
        <Button
          type="button"
        // `new-${prefix}`, so the default prefix still spells `new-tab` and
        // every e2e locator on that id keeps pointing at this bar's button.
        // There are dozens of them: count them with
        // `grep -rn "getByTestId('new-tab')" tests/e2e/`, and see the note on
        // `testIdPrefix` above for why no number is written down. Derived
        // from the prefix rather than left fixed because two bars on screen
        // under one testid is a strict-mode violation in every one of them.
        data-testid={`new-${testIdPrefix}`}
        aria-label={newLabel}
        onClick={onNew}
        disabled={!canOpen}
        variant="ghost"
        size="icon-xs"
        className="ml-1 shrink-0 cursor-default text-muted-foreground"
      >
        <Plus />
      </Button>
      </div>
      {onOpenBrowser ? (
        <Button
          type="button"
          // Fixed rather than derived from `testIdPrefix` the way `new-` above
          // is, because this button exists only where `onOpenBrowser` is
          // passed. Two bars offering it at once would put two elements under
          // this one id on screen, a strict-mode violation in every locator
          // that takes it, so a second caller passing the prop has to derive
          // the id here first. It does not begin with `tab-`: the e2e suite
          // counts tabs with a `[data-testid^="tab-"]` prefix match, and an
          // element under that prefix inflates every one of those counts while
          // each assertion still passes.
          // This is the terminal bar's one browser action. A second bar passing
          // `onOpenBrowser` would create a duplicate id, so a future caller
          // must derive a distinct one here first.
          data-testid="open-devserver"
          aria-label="Launch browser"
          title="Launch browser"
          onClick={onOpenBrowser}
          // Off where there is no project for main to hang a pane on. Both of
          // those states are reachable and neither is quiet if this is left
          // live: with no project active at all the press does nothing
          // whatever, and on a project main has no row for it comes back as an
          // error banner from a control that looked ready. The caller decides
          // which projects those are.
          //
          // What it is NOT disabled for is the absence of a dev server. That
          // opens a blank pane on purpose: detection is a bonus here, never a
          // precondition.
          disabled={!canOpenBrowser}
          variant="outline"
          size="xs"
          className="mr-0.5 shrink-0 border-border bg-background/50 text-muted-foreground"
        >
          {/* Its own component since the tabs column draws it too. See
              `ui/BrowserWindowIcon.tsx` for what it is and why it is drawn. */}
          <BrowserWindowIcon />
          <span>Launch browser</span>
        </Button>
      ) : null}
      </TabsList>
    </Tabs>
  )
}
