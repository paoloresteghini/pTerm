import { useRef, useState } from "react";
import {
  canHaveSession,
  type TabDescriptor,
  type TabState,
} from "../shared/ipc";
import type { TabTreeNode } from "./lib/tabGroups";
import { StatusDot } from "./StatusDot";
import { elapsedLabel } from "./lib/elapsed";
import { tabLabel } from "./lib/tabLabel";
import { useColumnWidth } from "./lib/columnWidth";
import { usePaneDragDrop } from "./lib/usePaneDragDrop";
import {
  ColumnResizer,
  PanelHeading,
  PanelStrip,
  PanelSurface,
  type PanelSide,
} from "./ui/Panel";
import { BrowserWindowIcon } from "./ui/BrowserWindowIcon";
import { cn } from "./lib/cn";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { X } from "lucide-react";

/**
 * The active project's tabs, with each tab's other panes nested beneath it.
 *
 * The vertical answer to a bar that runs out of room: `TabBar` is a single
 * `overflow-x-auto` row of `whitespace-nowrap` tabs ending in a `+` button, so
 * once enough tabs are open the row scrolls and the `+` button scrolls out of
 * view with it. A list scrolls without limit instead, and unlike a bar it has
 * somewhere to put a child, so a split reads as belonging to its tab rather
 * than as a neighbour of it.
 *
 * `App.tsx` renders the bar only while this column's full list is not open
 * (`showsTabBar`), so the tab list and the bar are never both on screen and
 * cannot disagree.
 */
export function TabsPanel({
  nodes,
  activeId,
  status,
  since,
  now,
  dead,
  collapsed,
  onToggle,
  onDragStart,
  onSelect,
  onClose,
  onRename,
  onOpenBrowser,
  canOpenBrowser,
  onJoin,
  canJoin,
  side,
  embedded = false,
}: {
  nodes: TabTreeNode[];
  activeId: string | null;
  status: Record<string, TabState>;
  since: Record<string, number>;
  now: number;
  /** Epoch ms a pane's session exited, keyed by pane id. Matches `TabBar`'s prop of the same name. */
  dead: Record<string, number>;
  collapsed: boolean;
  onToggle: () => void;
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void;
  onSelect: (paneId: string) => void;
  onClose: (paneId: string) => void;
  /**
   * Commit a new name, or clear it with a blank string. Same handler
   * `TabBar` is given (`renameTab`), because this column replaces that bar
   * rather than sitting beside it: a rename that only one of the two
   * surfaces offered would be a rename the user cannot reach whenever the
   * other one is on screen.
   */
  onRename: (paneId: string, name: string) => void;
  /**
   * Open the project's dev server in a browser pane, the same press the
   * terminal tab bar offers.
   *
   * Here because this column REPLACES that bar rather than sitting beside it
   * (`showsTabBar`), so with the column open the control had nowhere to be
   * and the gesture was simply unavailable. Optional so a caller that has no
   * project to hang a pane on can leave it out entirely and draw no button,
   * which is a different state from the disabled one below.
   */
  onOpenBrowser?: () => void;
  /**
   * Whether that press can do anything. Off where there is no project for
   * main to hang a pane on: with none active the press does nothing at all,
   * and on a project main has no row for it comes back as an error banner
   * from a control that looked ready. Not off for the ABSENCE of a dev
   * server, which opens a blank pane on purpose.
   */
  canOpenBrowser?: boolean;
  /** Drag one pane's row onto another's to merge them into a split. */
  onJoin: (paneId: string, targetPaneId: string) => void;
  /** Whether dragging `paneId` onto `targetPaneId` would do anything. */
  canJoin: (paneId: string, targetPaneId: string) => boolean;
  side: PanelSide;
  /** Renders beneath Environment in Workspace Light instead of in the row. */
  embedded?: boolean;
}) {
  const { width, set, commit } = useColumnWidth("pterm:tabsWidth", 208);
  const drag = usePaneDragDrop(canJoin, onJoin);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Which edit is still open, readable synchronously so that whichever of the
  // two commit paths arrives second is a no-op. Enter and Escape both unmount
  // the input, and today's Chromium does not reliably follow that with a blur.
  // Copied from `TabBar`, which copied it from `Sidebar`'s project rename.
  const editing = useRef<string | null>(null);

  const startRename = (pane: TabDescriptor): void => {
    editing.current = pane.id;
    // The raw title, not `tabLabel`: opening the field on an unnamed pane
    // should offer an empty box, not the slug and id to delete first.
    setDraft(pane.title ?? "");
    setRenamingId(pane.id);
  };

  const finishRename = (id: string, commit: boolean): void => {
    if (editing.current !== id) return;
    editing.current = null;
    setRenamingId(null);
    // No non-empty guard: a blank name is how a pane's name is removed, and a
    // pane has `tabLabel`'s slug-and-id default to fall back to.
    if (commit) onRename(id, draft.trim());
  };

  // After the hooks, never before: an early return above them would change the
  // hook order between the collapsed and expanded renders.
  if (collapsed) {
    return (
      <PanelStrip
        testid="tabs-toggle"
        label="Tabs"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
        embedded={embedded}
      />
    );
  }

  /** Identifies a pane's position within a split for tests and drag feedback. */
  const bracketAt = (
    index: number,
    size: number,
  ): "first" | "middle" | "last" | null => {
    if (size < 2) return null;
    if (index === 0) return "first";
    return index === size - 1 ? "last" : "middle";
  };

  const row = (
    pane: TabDescriptor,
    bracket: "first" | "middle" | "last" | null,
  ) => {
    const label = elapsedLabel(since[pane.id] ?? null, now);
    // Matches `TabBar`'s own `tombstoned`: a terminal pane whose session has
    // exited has nothing left for `onClose` to kill. `TabBar` swaps in
    // Restart/Dismiss for this case instead of a close control; this column
    // does not offer either yet, so the honest thing is to offer neither
    // control rather than a × that reaches `manager.kill()` and throws.
    const tombstoned = canHaveSession(pane) && dead[pane.id] !== undefined;
    return (
      <TabsTrigger
        key={pane.id}
        value={pane.id}
        asChild
        className={cn(
          "group h-8 min-h-8 cursor-default gap-1.5 rounded-md px-2 font-sans text-[13px] font-normal normal-case tracking-normal",
          drag.over === pane.id ? "ring-1 ring-inset ring-ring" : "",
        )}
      >
        <div
          // Every row is a pane, so every row is named the same way. The old
          // `vtab-`/`vpane-` split encoded a parent and a child, which is the
          // hierarchy this shape exists to remove; where a row sits in its
          // group is reported by `data-bracket` instead.
          data-testid={`vpane-${pane.id}`}
          data-bracket={bracket ?? undefined}
          data-over={drag.over === pane.id || undefined}
          className="min-w-0"
          {...drag.propsFor(pane.id)}
        >
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
            style={{ background: pane.color ?? undefined }}
          />
          {renamingId === pane.id ? (
            <input
              data-testid={`vinput-${pane.id}`}
              // `App.tsx`'s ⌘ handler returns early inside this. Without it,
              // ⌘W typed mid-rename closes the pane and kills its session,
              // taking the half-typed name with it. Same attribute, same
              // reason, as `TabBar`'s field.
              data-shortcuts="off"
              aria-label={`Rename ${tabLabel(pane)}`}
              autoFocus
              // Selected, not just focused: renaming an already-named pane is
              // usually replacing the name.
              onFocus={(event) => event.target.select()}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => finishRename(pane.id, true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishRename(pane.id, true);
                if (event.key === "Escape") finishRename(pane.id, false);
              }}
              // Stops the click that lands in the field from also re-selecting
              // the pane underneath it.
              onClick={(event) => event.stopPropagation()}
              className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          ) : (
            <span
              data-testid={`vlabel-${pane.id}`}
              // Not `vpane-`-prefixed: this column's rows are counted by
              // `[data-testid^="vpane-"]`, so a second element per row under
              // that prefix would inflate every one of those counts.
              onDoubleClick={(event) => {
                event.stopPropagation();
                startRename(pane);
              }}
              className="flex-1 truncate"
            >
              {tabLabel(pane)}
            </span>
          )}
          {label === null ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {label}
            </span>
          )}
          <StatusDot
            state={status[pane.id] ?? null}
            testid={`vdot-${pane.id}`}
          />
          {tombstoned ? null : (
            <button
              data-testid={`vclose-${pane.id}`}
              aria-label={`Close ${tabLabel(pane)}`}
              className="shrink-0 cursor-default rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(event) => {
                // Or the row's own click would select the pane on its way out.
                event.stopPropagation();
                onClose(pane.id);
              }}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </TabsTrigger>
    );
  };

  return (
    <PanelSurface
      data-testid="tabs-panel"
      embedded={embedded}
      side={side}
      className={cn("bg-bg")}
      style={embedded ? undefined : { width }}
    >
      <PanelHeading
        testid="tabs-heading"
        label="Tabs"
        onClick={onToggle}
        onDragStart={onDragStart}
        action={
          onOpenBrowser ? (
            <button
              // The same id the tab bar's button carries, deliberately: the
              // two are alternatives that are never on screen together, so a
              // locator on it resolves to whichever surface is up. See the
              // note beside `TabBar`'s copy.
              data-testid="open-devserver"
              aria-label="Open the dev server in a browser pane"
              title="Open the dev server in a browser pane"
              onClick={onOpenBrowser}
              disabled={canOpenBrowser === false}
              className="flex shrink-0 cursor-default items-center border-none bg-transparent px-2.5 pb-1 pt-3 text-faint disabled:opacity-40 enabled:hover:text-fg"
            >
              <BrowserWindowIcon />
            </button>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 p-2">
        <Tabs
          orientation="vertical"
          value={activeId ?? undefined}
          onValueChange={onSelect}
          className="h-full min-h-0 w-full gap-0"
        >
          <TabsList className="h-full min-h-0 w-full items-stretch justify-start overflow-y-auto rounded-md bg-secondary p-1">
            {nodes.map((node) => (
              <div key={node.panes[0]?.id ?? ""} className="w-full">
                {node.panes.map((pane, index) =>
                  row(pane, bracketAt(index, node.panes.length)),
                )}
              </div>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {!embedded ? (
        <ColumnResizer
          testid="tabs-resizer"
          side={side}
          width={width}
          onResize={set}
          onCommit={commit}
        />
      ) : null}
    </PanelSurface>
  );
}
