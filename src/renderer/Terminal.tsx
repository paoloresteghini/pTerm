import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { PaneColor } from '../shared/paneColors'
import { findLinks, followsLink, linkRange } from './lib/terminalLinks'
import { dropText } from './lib/shellQuote'
import { leastRecentlyUsed, webglPaneBudget } from './lib/webglBudget'

/**
 * Every mounted pane's terminal, by tab id.
 *
 * A module-level map rather than something handed upward, because the caller
 * that needs it — App's ⌘D — holds no reference to any terminal and has to
 * name the pane it is splitting by id. The only alternative in reach is
 * measuring the box in pixels and dividing by a guessed cell size.
 */
const mounted = new Map<string, XTerm>()

/**
 * Which renderer each mounted pane actually got.
 *
 * The WebGL addon is best effort: its constructor throws when WebGL is
 * unavailable at all. That fallback used to be completely silent, which is why
 * a pane drawing block characters as underscores could only be noticed by eye
 * — the DOM renderer cannot draw `customGlyphs`, so the context bar in Claude
 * Code's status line degrades exactly when this map says `dom`.
 */
const renderers = new Map<string, 'webgl' | 'dom'>()

/**
 * The addon each pane is holding, so a pane can be asked to give it up again.
 *
 * Keyed the same as `renderers`, and the two are written together: an id in
 * here is an id `renderers` says is on `webgl`.
 */
const addons = new Map<string, WebglAddon>()

/**
 * When each pane was last used, on a counter that only goes up.
 *
 * A counter and not a clock: two panes touched in the same millisecond still
 * order, and no eviction can be changed by the machine's clock moving.
 */
const lastUsed = new Map<string, number>()
let useTick = 0

/**
 * The panes on the tab that is on screen.
 *
 * Kept because a pane the user can SEE must never be the one that gives up its
 * context: it would carry on drawing, on a renderer whose cells are a
 * different width from the grid it was last measured for. Every other pane can
 * lose one silently and get it back on the way in.
 */
const onScreen = new Set<string>()

function markUsed(tabId: string): void {
  lastUsed.set(tabId, ++useTick)
}

/**
 * Give up `tabId`'s WebGL context.
 *
 * Deliberately does NOT re-measure the pane afterwards, which is the opposite
 * of what it looks like it should do and cost a red test run to establish.
 * **Measured 2026-08-08:** the two renderers disagree about how wide a cell
 * is. The WebGL renderer rounds it to whole DEVICE pixels — 15 device, 7.5 css
 * at this display's ratio of 2 — where the DOM renderer uses the font's true
 * advance of about 7.83. Over the same 1035px pane that is 138 columns against
 * 133, and `FitAddon` divides by whichever the render service currently
 * reports.
 *
 * A hidden tab in this app is `visibility: hidden` and not `display: none`
 * precisely so it stays laid out and can keep measuring itself (`App.tsx`, the
 * group's class list). So a re-fit here does NOT quietly no-op on a background
 * pane the way one might expect — it runs, and pushes 133 to a tmux session
 * nobody is looking at, which Claude Code answers by rewrapping its entire
 * scrollback. Then the pane comes back on screen, takes a context, and rewraps
 * it all again at 138. Leaving the grid alone is what spares the user both.
 *
 * The pane is left drawing a 138-column grid with 7.83px cells until it is
 * next shown, at which point `claimRenderer` runs BEFORE the fit and the two
 * agree again. Nobody is looking at it in between — that is what `onScreen`
 * above guarantees about who can be picked.
 */
function releaseRenderer(tabId: string): void {
  const addon = addons.get(tabId)
  if (addon === undefined) return
  addons.delete(tabId)
  renderers.set(tabId, 'dom')
  addon.dispose()
}

/**
 * Put `tabId`'s terminal on the WebGL renderer, taking a context from the pane
 * that has gone longest without use if the budget is already full.
 *
 * Why there is a budget at all: Chromium caps live WebGL contexts per renderer
 * process at 16, and past that it does not fail the request — it force-loses
 * one of the contexts that already exist, choosing by its own
 * least-recently-DRAWN order. An idle Claude Code session draws nothing while
 * it waits, so the pane Chromium picks is routinely one the user is sitting
 * and looking at, and xterm's fallback to the DOM renderer is permanent once
 * it happens. Keeping the count under the cap ourselves is what takes that
 * decision back, and ordering it by USE rather than by paint is what makes the
 * panes someone is working in the ones that keep the renderer.
 *
 * Idempotent: a pane that already holds a context keeps the one it has, so the
 * `visible` effect can call this on every tab switch without any attach and
 * dispose churn.
 *
 * Does NOT re-measure the pane; both callers fit afterwards, and the contract
 * is only that the claim comes FIRST. The renderers disagree about cell width
 * (see `releaseRenderer`), so a fit taken while the pane is still on the old
 * one pushes that renderer's column count to tmux and nothing later corrects
 * it. How much later the fit happens does not matter: the mount effect's is
 * synchronous and the `visible` effect's is a frame away, and measured
 * 2026-08-08 the render service already reports the new cell width on the
 * statement after `loadAddon`, so neither needs a delay to be right.
 */
function claimRenderer(tabId: string, term: XTerm): void {
  if (addons.has(tabId)) return
  const budget = webglPaneBudget(window.pterm.webglLimit)
  while (addons.size >= budget) {
    const victim = leastRecentlyUsed(
      [...addons.keys()].filter((id) => id !== tabId && !onScreen.has(id)),
      lastUsed,
    )
    // Nothing left that can be taken from without a pane on screen changing
    // renderer under the user. Reachable when one tab holds more panes than
    // the budget: the ones past it stay on the DOM renderer, measure
    // themselves for it, and draw Claude Code's block characters as slivers —
    // which is the honest outcome, and better than making a pane the user is
    // reading do the same. Also the guard that stops this loop running forever.
    //
    // Recorded as `dom` on the way out rather than left unset: a pane missing
    // from `renderers` reads as a pane that does not exist, and this is the
    // one path that reaches the DOM renderer without an error to go with it.
    if (victim === null) {
      renderers.set(tabId, 'dom')
      return
    }
    releaseRenderer(victim)
  }
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      // Only when this is still the pane's live addon. `releaseRenderer`
      // disposes through the same object, and xterm's own dispose loses the
      // context on the way out, which comes back through here — without this
      // the eviction path would dispose twice and throw.
      if (addons.get(tabId) !== webgl) return
      addons.delete(tabId)
      renderers.set(tabId, 'dom')
      webgl.dispose()
      // No re-fit, for the same reason `releaseRenderer` gives none: the grid
      // is left as it is until the pane is next shown, which re-claims first
      // and measures after. Reaching here at all means something outside this
      // app's budget took a context, since the budget is set below the cap
      // Chromium enforces.
      //
      // Said out loud: a pane that silently drops to the DOM renderer starts
      // drawing box and block characters as underscore slivers, and nothing
      // else in the app would ever mention it.
      console.warn(`pTerm: pane ${tabId} lost its WebGL context; falling back to the DOM renderer`)
    })
    term.loadAddon(webgl)
    addons.set(tabId, webgl)
    renderers.set(tabId, 'webgl')
  } catch (error) {
    // WebGL unavailable at all — headless GL, a driver that refuses. Keep the
    // DOM renderer, degraded but working.
    renderers.set(tabId, 'dom')
    console.warn(`pTerm: pane ${tabId} could not start the WebGL renderer`, error)
  }
}

declare global {
  interface Window {
    /** See `renderers`. Read by the e2e suite and useful from a devtools console. */
    __ptermRenderers?: () => Record<string, 'webgl' | 'dom'>
  }
}

window.__ptermRenderers = () => Object.fromEntries(renderers)

declare global {
  interface Window {
    /** See the assignment below. Optional so a page without this module loaded reads undefined, not a type lie. */
    __ptermTerminalTexts?: () => Array<{ id: string; text: string }>
  }
}

/**
 * Every mounted pane's buffer as text, keyed by the same id `pane-${id}`
 * testids carry, in mount order.
 *
 * For the e2e suite, which until the WebGL renderer could read a pane's
 * content out of `.xterm-rows`. The WebGL renderer paints to a canvas and
 * leaves that element empty, so the DOM no longer carries the text at all;
 * the buffer is the only place it still exists, and this is the only door to
 * it from a Playwright `evaluate`. Shipped in the real app rather than gated
 * behind a test flag: it is read-only, and a gate would mean the suite runs a
 * renderer the user does not.
 *
 * The id is there so a caller can keep the distinction `terminal-active`
 * used to give it for free: which TAB's panes it is reading. The harness
 * resolves ids under that testid in the DOM and picks those buffers out of
 * this list; text alone could not say whose it was, and a negative assertion
 * ("the hidden tab's marker is not on the active tab") is exactly a claim
 * about whose text this is.
 *
 * Whole buffer, scrollback included, where `.xterm-rows` held only the
 * viewport: a marker that scrolled off screen used to fail the assertion and
 * now passes. The suite's negative assertions all read panes young enough to
 * have no scrollback, so nothing today can match on scrolled-off text.
 */
window.__ptermTerminalTexts = () =>
  [...mounted.entries()].map(([id, term]) => {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return { id, text: lines.join('\n') }
  })

/**
 * The cell grid `tabId`'s terminal is showing right now, or null when no
 * terminal is mounted for it.
 *
 * Null rather than a default pair: a split sized from a made-up grid is the
 * 80x24 defect wearing different numbers, and the caller has a better answer
 * for "not measured" than this file does.
 */
export function paneGrid(tabId: string): { cols: number; rows: number } | null {
  const term = mounted.get(tabId)
  return term ? { cols: term.cols, rows: term.rows } : null
}

/**
 * Put the keyboard back on `tabId`'s terminal.
 *
 * For the history overlay, which takes DOM focus for its filter box and has to
 * hand it back when it closes. Nothing else would: the `focused` prop below
 * only moves focus when it CHANGES, and opening an overlay on the active pane
 * does not change which pane is active, so the effect that normally does this
 * never re-runs. Without this call a dismissed overlay leaves focus on `body`
 * and the pane stops answering the keyboard.
 *
 * Silent for a tab with no terminal mounted, the way `paneGrid` returns null
 * for one: an editor pane has no xterm and asking it for focus is not an error.
 */
export function focusTerminal(tabId: string): void {
  mounted.get(tabId)?.focus()
}

/**
 * `tabId`'s current selection, or '' when it has none.
 *
 * For the pane menu's Copy, which is disabled on an empty answer. Reads
 * through the same `mounted` map as `paneGrid` and `focusTerminal`, and
 * answers '' rather than null for a pane with no terminal: an editor pane has
 * no xterm, and asking it for a selection is not an error.
 */
export function selectionOf(tabId: string): string {
  return mounted.get(tabId)?.getSelection() ?? ''
}

/**
 * Empty `tabId`'s scrollback.
 *
 * xterm's own buffer only. tmux keeps the deeper history and is untouched, so
 * this is "clear what I am looking at" and not "destroy the record" — the menu
 * item says as much, because the two are easy to confuse and only one is
 * recoverable.
 */
export function clearTerminal(tabId: string): void {
  mounted.get(tabId)?.clear()
}

export function Terminal({
  tabId,
  visible,
  /** Whether this pane is the one the keyboard is talking to. */
  focused,
  /** This pane's background. `PANE_COLOR_DEFAULT` when it has none of its own. */
  color,
  /**
   * Offer this pane's Up to the history overlay. `true` means the overlay took
   * it and xterm must not also send `\x1b[A`; `false` means it declined and
   * this pane's Up belongs to the shell exactly as it always has.
   */
  onHistoryRequested,
}: {
  tabId: string
  visible: boolean
  focused: boolean
  color: PaneColor
  onHistoryRequested: (paneId: string) => boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const termRef = useRef<XTerm | null>(null)
  // Read through a ref by the key handler below, so a new callback identity on
  // a parent render cannot land in the mount effect's dependencies. That effect
  // builds the xterm; re-running it would dispose this pane's terminal and take
  // its scrollback with it.
  const historyRef = useRef(onHistoryRequested)
  useEffect(() => {
    historyRef.current = onHistoryRequested
  }, [onHistoryRequested])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      /*
       * The monospace faces first, then a symbol face, then the generic.
       *
       * Claude Code's chrome prints characters no macOS monospace font has a
       * glyph for — `⏵⏵` (U+23F5) for auto mode is the one that shows, and
       * `⚠`, `●` and the braille spinner are the same class. xterm rasterises
       * into a canvas atlas, and where a family has no glyph it takes a
       * substitute whose metrics do not fit the cell, which clips to a sliver
       * that reads on screen as a stray underscore. Terminal.app and iTerm2
       * run a full CoreText fallback instead, which is why the same session
       * looks correct there and wrong here.
       *
       * `Apple Symbols` is appended rather than inserted: it is not
       * monospaced, so putting it ahead of Menlo would change the metrics of
       * ordinary text. Last before the generic, it is consulted only for
       * characters nothing above it can draw.
       */
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, 'Apple Symbols', monospace",
      fontSize: 13,
      allowProposedApi: true,
      // Bounded per-pane so twelve live panes cannot grow without limit.
      // tmux keeps the deeper history.
      scrollback: 5000,
      // xterm renders to a canvas and cannot read the CSS variables in
      // index.css, so the foreground repeats --color-term-fg by hand. The
      // background is the pane's own, defaulting to --color-bg, and the
      // effect below is what carries a later change to it.
      //
      // Set here as well as there so a pane that mounts already coloured
      // never paints one frame of the default first, which a restored window
      // full of coloured panes would show as a flash on every launch.
      theme: { background: color, foreground: '#d4d4d8' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    // After `open()`, which the addon requires. The DOM renderer draws every
    // character from the font, and the glyphs Claude Code's chrome leans on
    // (`╭`, `⏺`, `⏵⏵`, its spinner) are not in SF Mono or Menlo — the
    // fallback font's metrics leave a clipped sliver in the cell that reads
    // as a stray underscore. The WebGL renderer rasterises into its own
    // atlas and draws box/block characters itself (`customGlyphs`, on by
    // default), which the DOM renderer explicitly cannot do.
    //
    // Marked used first, so a pane opening into a full budget takes its
    // context from some older pane and not from itself.
    //
    // No `webgl.dispose()` in the unmount cleanup: `term.dispose()` below
    // already disposes registered addons. What the cleanup does have to do is
    // forget the entry in `addons`, or the next eviction would dispose an
    // addon belonging to a terminal that is already gone.
    markUsed(tabId)
    claimRenderer(tabId, term)
    termRef.current = term
    mounted.set(tabId, term)

    // The two keys this app takes off xterm, each only when there is
    // something to put in its place: Shift+Return (replaced by ESC CR) and
    // ⌘↑ (offered to the history overlay). Returning `true` is xterm's
    // untouched behaviour, so every other branch leaves this terminal exactly
    // as it was before this handler existed.
    //
    // ⌘↑ is the one Up this app can spend. Read in
    // `node_modules/@xterm/xterm/lib/xterm.js` on 2026-08-06,
    // `evaluateKeyboardEvent` builds `(shiftKey?1:0)|(altKey?2:0)|(ctrlKey?4:0)|(metaKey?8:0)`
    // and `case 38` emits `ESC[1;<that+1>A` whenever it is non-zero, so ⇧↑, ⌃↑
    // and ⌥↑ are each a DISTINCT sequence sent to whatever is running in the
    // pane, and a BARE Up is the plain `ESC[A`/`ESC OA` that every shell,
    // editor and TUI reads as "previous". Swallowing any of those takes a
    // keystroke away from that program — which is exactly what claiming a bare
    // Up for this overlay used to do to Claude Code, vim and less. ⌘↑ is the
    // exception xterm makes for itself: `case 38` breaks on `metaKey` and
    // sends nothing at all, so this is the only Up whose interception costs
    // the program in the pane nothing.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      // Shift+Return goes to the pty as ESC CR, not the bare CR xterm would
      // send (its `case 13` ignores `shiftKey`, so a program behind the pty
      // cannot tell the two returns apart). ESC CR is the sequence Claude
      // Code's own `/terminal-setup` teaches VS Code and iTerm2 to send for
      // Shift+Return, and is what it reads as "newline, don't submit". A
      // shell just treats it as Meta+Return and accepts the line, which is
      // what an unmodified Return did there anyway.
      //
      // Written to the same channel as `term.onData` below rather than
      // through xterm, which has no way to send input it did not synthesise.
      if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        window.pterm.input(tabId, '\x1b\r')
        // Returning false stops xterm HANDLING the key; it does not stop the
        // browser's default action, and the hidden textarea still produced a
        // Return of its own. Measured 2026-08-07: one Shift+Return emitted the
        // ESC CR above and then `onData "\r"`, so a program behind the pty saw
        // "newline, then submit" — which is Claude Code taking the line the
        // keystroke was meant to keep open.
        event.preventDefault()
        return false
      }
      if (event.key !== 'ArrowUp') return true
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return true
      return !historyRef.current(tabId)
    })

    /*
     * ⌘-click a url to open it in the browser.
     *
     * xterm 6's own `registerLinkProvider` rather than
     * `@xterm/addon-web-links`: that addon's stable line (0.12.0) predates
     * xterm 6 and the only builds for it are betas, so this avoids a beta
     * dependency for thirty lines of provider.
     *
     * `translateToString(true)` trims trailing whitespace, which is what makes
     * the offsets `findLinks` returns line up with the cells: it only ever
     * removes cells AFTER the last non-space one, and a url is never there.
     * A wrapped url is not handled — the second half is a different buffer
     * line, and each is offered on its own — so a link broken across the right
     * edge opens only the part the click landed on.
     *
     * The `activate` gate and the scheme filter both sit in
     * `lib/terminalLinks.ts` under unit test, because nothing past this point
     * is observable from an e2e: `shell.openExternal` cannot be intercepted
     * from a spec. Main validates the scheme again in the `openExternal`
     * handler, which is the boundary that actually protects the user.
     */
    const linkDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) return callback(undefined)
        const text = line.translateToString(true)
        const found = findLinks(text)
        if (found.length === 0) return callback(undefined)
        callback(
          found.map(({ url, start, end }) => ({
            range: linkRange({ start, end }, bufferLineNumber),
            text: url,
            activate(event) {
              if (!followsLink(event)) return
              void window.pterm.openExternal(url)
            },
          })),
        )
      },
    })

    const offData = window.pterm.onData(({ id, data }) => {
      if (id === tabId) term.write(data)
    })
    const inputDisposable = term.onData((data) => window.pterm.input(tabId, data))

    const fitToContainer = (): void => {
      // A hidden container measures 0×0; fitting to that would resize the
      // real tmux session down to nothing.
      if (container.offsetParent === null) return
      // `offsetParent` is null for `display: none` and for a detached node,
      // but not for an element that simply has no box to speak of — a flex
      // item handed a zero share, or a window with nothing on screen yet.
      // FitAddon floors its proposal at 2 cols by 1 row rather than declining
      // to answer (`Math.max(2, …)`, `Math.max(1, …)`), so measuring one of
      // those would drive the real session to 2×1 with the guard above
      // waving it through. The ResizeObserver below re-fits the moment the
      // box is real, so skipping here costs nothing.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fit.fit()
      window.pterm.resize(tabId, term.cols, term.rows)
    }
    fitRef.current = fitToContainer

    fitToContainer()

    const observer = new ResizeObserver(fitToContainer)
    observer.observe(container)

    return () => {
      observer.disconnect()
      linkDisposable.dispose()
      inputDisposable.dispose()
      offData()
      // Before `term.dispose()`, which disposes the addon with it: an entry
      // left behind would let a later eviction dispose it a second time.
      addons.delete(tabId)
      term.dispose()
      renderers.delete(tabId)
      lastUsed.delete(tabId)
      onScreen.delete(tabId)
      fitRef.current = null
      termRef.current = null
      // Only if it is still this terminal's entry. Nothing schedules a mount
      // for one id ahead of the matching cleanup today, but the cost of being
      // wrong about that is a live pane whose grid nothing can read, which
      // makes ⌘D on it refuse to split.
      if (mounted.get(tabId) === term) mounted.delete(tabId)
    }
  }, [tabId])

  // Live, rather than by recreating the terminal: `theme` is a settable
  // option, and rebuilding an xterm to repaint it would throw away the
  // scrollback the pane is holding, which is the one thing a terminal cannot
  // be asked to lose over a colour.
  //
  // Not in the mount effect's dependencies for the same reason: adding
  // `color` there would tear down and rebuild the terminal on every change.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = { ...term.options.theme, background: color }
  }, [color])

  // A tab coming back on screen is what makes its panes recently used, and the
  // moment to take a WebGL context back for them: a pane that gave one up
  // while it was hidden is drawing Claude Code's block characters as
  // underscores until it does. Claiming BEFORE the fit rather than after is
  // the ordering the whole thing turns on — the two renderers disagree about
  // the width of a cell, so a fit measured under the wrong one pushes the
  // wrong column count to tmux. See `releaseRenderer` for the numbers.
  //
  // A no-op for a pane that never lost its context, which is every pane in an
  // app small enough not to reach the budget.
  useEffect(() => {
    if (!visible) {
      onScreen.delete(tabId)
      return
    }
    onScreen.add(tabId)
    markUsed(tabId)
    const term = termRef.current
    if (term) claimRenderer(tabId, term)
    // The claim above happens BEFORE this fit and not inside it. That order is
    // the one thing in this effect that must not be swapped, and it is
    // measured: moving the claim into the frame leaves the pane measured under
    // the renderer it is about to stop using, and `webgl.spec.ts`'s size
    // assertion goes red at 133 columns where it should read 138.
    const frame = requestAnimationFrame(() => {
      fitRef.current?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, tabId])

  // Typing has to land in the pane the app says is active, or it goes to
  // whichever terminal happened to hold focus. This only ever takes focus, and
  // only on the way in: nothing here blurs a pane, and a pane that is not on
  // screen is never asked for focus because the caller passes false for one.
  //
  // Also the finest-grained "this one is in use" the app has: `visible` is
  // true for every pane on the active tab at once, so without this a split
  // the user has been typing in for an hour orders the same as its idle
  // neighbour and could lose its renderer first.
  useEffect(() => {
    if (!focused) return
    markUsed(tabId)
    termRef.current?.focus()
  }, [focused, tabId])

  return (
    <div
      data-testid="terminal"
      ref={containerRef}
      className="h-full w-full"
      /*
       * Dropping files onto a pane types their paths at the cursor.
       *
       * `preventDefault` on dragover is what makes this element a drop target
       * at all: without it the browser refuses the drop and Electron falls
       * back to navigating the window to the file, which replaces the app with
       * the file's contents and reads as a crash. `App.tsx` swallows drops
       * everywhere else for that same reason; this is the one place a drop
       * does something.
       */
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        const text = dropText([...event.dataTransfer.files].map(window.pterm.pathForFile))
        // Nothing typed for a drag that carried no resolvable file — a text
        // selection, or a drag from another app. A stray space in a
        // half-written command is worse than doing nothing.
        if (text === '') return
        window.pterm.input(tabId, text)
      }}
    />
  )
}
