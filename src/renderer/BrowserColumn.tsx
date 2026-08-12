import type { ProjectDescriptor } from '../shared/ipc'
import type { PaneColor } from '../shared/paneColors'
import { BrowserPane } from './BrowserPane'
import { TabBar } from './TabBar'
import { cn } from './lib/cn'
import { useColumnWidth } from './lib/columnWidth'
import type { TabGroupEntry } from './lib/tabGroups'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'
import { projectIdForTab, type PaneGroup } from './workspace'

/**
 * The four pane-id maps `TabBar` takes, empty because nothing can put a
 * browser pane in one. `status`, `since` and `dead` are written from a pty's
 * events (`App`'s `onStatus`, `statusSnapshot` and `died`), and a browser pane
 * has no session to emit them; `dirty` is `FileView`'s, keyed by editor panes.
 *
 * `now` is passed 0 below for the same reason: the bar reads it only to label
 * how long a tab has been in its state, and only for a tab that has one.
 */
const NONE: Record<string, never> = {}

/**
 * Restart, dismiss and join are all off below, so `TabBar` renders no control
 * that reaches these. They are here because the props are required.
 */
const noop = (): void => {}

/**
 * The browser region: its own tab bar and its own pane area, in a column of
 * its own beside the terminal.
 *
 * The column's three states are every other column's, and come from the same
 * machinery: `App` decides whether to render it at all, `collapsed` chooses
 * between the strip and the panel, and `useColumnWidth` holds the width the
 * resizer drags. What is different is the body: one `TabBar` and the panes it
 * names, rather than a list.
 */
export function BrowserColumn({
  groups,
  tabs,
  activeId,
  projects,
  collapsed,
  onToggle,
  onDragStart,
  onActivate,
  onClose,
  onNew,
  onRename,
  onRecolor,
  canOpen,
  side,
}: {
  /** `paneGroups(state, 'browser')`: one group per tab, only ever one visible. */
  groups: PaneGroup[]
  /** The bar's rows, grouped the same way the terminal bar's are. */
  tabs: TabGroupEntry[]
  activeId: string | null
  /** Resolves each pane's project id, as `App` does for a terminal pane. */
  projects: ProjectDescriptor[]
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onRecolor: (id: string, color: PaneColor | null) => void
  /** Whether the bar's `+` can open anything. See `canOpenSession`. */
  canOpen: boolean
  side: PanelSide
}) {
  // 480 rather than the 208 the list columns default to: this one holds a web
  // page, not a column of names. It is inside `clampColumnWidth`'s 140..560,
  // so a stored width and this default live on the same scale.
  const { width, set, commit } = useColumnWidth('pterm:browserWidth', 480)

  if (collapsed) {
    return (
      <PanelStrip
        testid="browser-toggle"
        label="Browser"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  return (
    <div
      data-testid="browser-column"
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-surface select-none',
        // The seam faces the terminal either way, the same rule `NotesPanel`
        // and `PanelStrip` follow: a left column drawing `border-l` puts its
        // only border against the window frame, where nothing can see it.
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      <PanelHeading
        testid="browser-toggle"
        label="Browser"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <TabBar
        // Not the default `'tab'`: the e2e suite counts terminal tabs with a
        // `[data-testid^="tab-"]` prefix match, which a second bar under that
        // prefix would inflate. See `TabBar`'s own note on `testIdPrefix`.
        testIdPrefix="browsertab"
        newLabel="New browser pane"
        // A browser pane has no session, so it cannot die, cannot be
        // restarted or dismissed, and has no terminal for another tab to join
        // it to.
        capabilities={{ restart: false, dismiss: false, join: false }}
        tabs={tabs}
        activeId={activeId}
        status={NONE}
        since={NONE}
        now={0}
        dead={NONE}
        dirty={NONE}
        onActivate={onActivate}
        onClose={onClose}
        onRestart={noop}
        onDismiss={noop}
        onNew={onNew}
        onRename={onRename}
        onRecolor={onRecolor}
        onJoin={noop}
        canJoin={() => false}
        canOpen={canOpen}
      />
      <div className="relative min-h-0 flex-1">
        {/* While the column is open, every browser pane in it stays mounted,
            whichever tab is on screen and whichever project is active: this
            list is unconditional and nothing filters it down to what is
            visible, so switching tabs or projects hides a pane rather than
            unmounting it, and the page it is showing survives the switch.
            `paneGroups` decides the arrangement.

            COLLAPSING the column is the exception, and it is not a small one.
            The `collapsed` branch above returns the strip and nothing else, so
            collapsing unmounts every `<webview>` here; expanding builds new
            ones from each pane's saved URL (`BrowserPane` reads `url` once
            into the element's `src`), with the history behind it gone. The
            paragraph above is therefore a rule about tab and project
            switches, not about this column's own two states. */}

        {/* Hidden with `visibility` rather than `display`, the same rule the
            terminal groups follow: a pane that is off screen keeps its box
            instead of collapsing to nothing. */}
        {groups.map((group) => (
          <div
            key={group.id}
            data-testid={group.visible ? 'browser-active' : `browsergroup-${group.id}`}
            className={cn(
              // The hairline `gap` draws the seam between two panes of one
              // group, and `bg-clip-content` stops the colour under it from
              // painting the `p-2` frame as well. Both copied from the
              // terminal groups, whose comment carries the arithmetic.
              'absolute inset-0 flex gap-px bg-border bg-clip-content p-2',
              group.visible ? 'visible z-10' : 'invisible z-0 pointer-events-none',
            )}
            style={group.style}
          >
            {group.panes.map((box) => (
              <div
                key={box.pane.id}
                data-testid={`pane-${box.pane.id}`}
                className="relative min-h-0 min-w-0"
                // `var(--color-bg)` rather than a literal for an uncoloured
                // pane, so the box follows the theme's canvas the way the
                // terminal pane boxes do.
                style={{ ...box.style, background: box.pane.color ?? 'var(--color-bg)' }}
              >
                <BrowserPane
                  paneId={box.pane.id}
                  projectId={projectIdForTab(projects, box.pane)}
                  url={box.pane.url}
                  paneColor={box.pane.color}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      <ColumnResizer
        testid="resize-browser"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
