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
 * The column's three states are every other column's, and it holds all three
 * itself rather than letting `App` render two of them and nothing for the
 * third: HIDDEN draws nothing anywhere, COLLAPSED draws the strip, and open
 * draws the panel. `useColumnWidth` holds the width the resizer drags.
 *
 * Two things are different from the list columns. The body is one `TabBar`
 * and the panes it names, rather than a list. And neither of the two states
 * that draw nothing unmounts anything: a `<webview>` cannot be rebuilt where
 * it left off the way a list can, so both hide the panes where they stand.
 */
export function BrowserColumn({
  groups,
  tabs,
  activeId,
  projects,
  hidden,
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
  /**
   * Off screen entirely: no strip, no panel, and no width in the row. The
   * panes stay mounted regardless, which is the whole reason this is a prop
   * rather than `App` rendering `null`. See `App`'s call site for the trade
   * that buys.
   */
  hidden: boolean
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onRecolor: (id: string, color: PaneColor | null) => void
  /** Whether the bar's `+` can open anything. See `App`'s call site. */
  canOpen: boolean
  side: PanelSide
}) {
  // 480 rather than the 208 the list columns default to: this one holds a web
  // page, not a column of names. It is inside `clampColumnWidth`'s 140..560,
  // so a stored width and this default live on the same scale.
  const { width, set, commit } = useColumnWidth('pterm:browserWidth', 480)

  // Both states that draw nothing put the panes in the same box, so there is
  // one thing to reason about rather than two.
  const putAway = hidden || collapsed

  // The panes' box, and the one place the two put-away states are expressed
  // as a style rather than as a different tree.
  //
  // `visibility` rather than `display`, and an explicit width rather than
  // whatever the column has left: measured 2026-08-11, reading a live guest
  // through `webContents.executeJavaScript`. Hidden this way, the guest
  // reports the same `innerWidth` and the same scroll position it had, and
  // fires no `resize` at all. Letting the same box shrink to the strip's
  // width instead reflowed the page to `innerWidth` 7, which is the state a
  // responsive page comes back from as its narrowest mobile layout.
  const paneBox = putAway
    ? cn(
        // `absolute`, so the column beside it is the 24px strip or nothing at
        // all, and the row pays nothing for a box this wide. `inset-y-0`
        // gives it the column's full height, where the open column spends
        // part of that height on the heading and the tab bar, so the guest IS
        // resized vertically on the way in and again on the way out. That is
        // a reflow, not a reload: the page, its scroll position and its
        // history all survive it, which is the point of putting it away
        // rather than unmounting it.
        'invisible pointer-events-none absolute inset-y-0 left-0',
        // The seam the open column draws, in the same place and the same
        // width, and transparent because the strip already draws a visible
        // one. Boxes here are `border-box`, so without this the open
        // column's 1px border is the whole difference between the two
        // states' inner widths, and the guest is resized by exactly that
        // 1px on every collapse (measured: 463 open against 464 collapsed).
        'border-transparent',
        side === 'left' ? 'border-r' : 'border-l',
      )
    : 'relative min-h-0 flex-1'

  const panes = (
    <div className={paneBox} style={putAway ? { width } : undefined}>
      {/* Hidden with `visibility` rather than `display`, the same rule the
          terminal groups follow: a pane that is off screen keeps its box
          instead of collapsing to nothing.

          The group that IS on screen sets no visibility of its own, and that
          is load-bearing rather than an omission. `visibility` inherits, but
          a descendant can override it, so the `visible` this used to carry
          would have re-shown the active pane straight through the box above
          whenever the box was hiding it. `App`'s terminal groups do carry it
          and are correct to: nothing ever hides the box around them. */}
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
            group.visible ? 'z-10' : 'invisible z-0 pointer-events-none',
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
  )

  // ONE tree for all three states, which is the whole reason this component
  // is shaped the way it is. React reconciles children by position, so a
  // branch that returned a different tree would take the `panes` element out
  // of the position it held and remount every `<webview>` under it. Measured
  // 2026-08-11, before this was one tree: a collapse and an expand left the
  // pane showing `about:blank` (the URL the pane RECORD still carries, since
  // navigation is written to main rather than back into renderer state), with
  // the page that had been there gone. So `hidden` and `collapsed` only ever
  // choose what goes in a fixed slot, or between two sets of classes, and
  // never between two shapes.
  return (
    <div
      // Only on the panel. A test asking for the panel by name is asking
      // about the panel, not about a strip or an empty box wearing its name.
      data-testid={putAway ? undefined : 'browser-column'}
      className={cn(
        'relative flex shrink-0',
        // A COLUMN stacks its heading, bar and panes, so open is `flex-col`.
        // Collapsed must not be: the strip is this box's only laid-out child,
        // and in a column its height is its own content, which left it a 45px
        // button over 600-odd pixels of bare canvas. In a row it is a flex
        // item on the cross axis and stretches, which is what it did when it
        // WAS the row's item, before this wrapper existed.
        collapsed ? '' : 'flex-col',
        hidden
          ? // Nothing drawn and no width taken: what is left is a zero-width
            // box holding the pane box, which is `absolute` and so costs the
            // row nothing either. `overflow-hidden` keeps that box's width
            // out of the window's own scrollable area.
            'w-0 overflow-hidden'
          : collapsed
            ? // Same reasoning, except the strip gives this box its 24px.
              // The strip draws its own border and background.
              'overflow-hidden'
            : cn(
                'border-border bg-surface select-none',
                // The seam faces the terminal either way, the same rule
                // `NotesPanel` and `PanelStrip` follow: a left column drawing
                // `border-l` puts its only border against the window frame,
                // where nothing can see it.
                side === 'left' ? 'border-r' : 'border-l',
              ),
      )}
      // Put away, the width is the strip's own `w-6` or the `w-0` above.
      style={putAway ? undefined : { width }}
    >
      {hidden ? null : collapsed ? (
        <PanelStrip
          testid="browser-toggle"
          label="Browser"
          side={side}
          onClick={onToggle}
          onDragStart={onDragStart}
        />
      ) : (
        <PanelHeading
          testid="browser-toggle"
          label="Browser"
          onClick={onToggle}
          onDragStart={onDragStart}
        />
      )}
      {putAway ? null : (
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
      )}
      {/* Every browser pane the column was handed stays mounted, whichever
          tab is on screen, whichever project is active, and whichever of the
          three states this column is in: `groups` is rendered whole and
          nothing filters it down to what is visible, so all of those hide a
          pane rather than unmounting it, and the page it is showing survives.
          `paneGroups` decides the arrangement.

          The one thing that unmounts them is `App` rendering no column at
          all, which it does only when there is no browser pane anywhere in
          the workspace, so there is nothing to keep alive. */}
      {panes}
      {putAway ? null : (
        <ColumnResizer
          testid="resize-browser"
          side={side}
          width={width}
          onResize={set}
          onCommit={commit}
        />
      )}
    </div>
  )
}
