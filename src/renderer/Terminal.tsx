import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { PaneColor } from '../shared/paneColors'

/**
 * Every mounted pane's terminal, by tab id.
 *
 * A module-level map rather than something handed upward, because the caller
 * that needs it — App's ⌘D — holds no reference to any terminal and has to
 * name the pane it is splitting by id. The only alternative in reach is
 * measuring the box in pixels and dividing by a guessed cell size.
 */
const mounted = new Map<string, XTerm>()

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
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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
    // Both failure paths land on the DOM renderer, degraded but working: a
    // thrown constructor is caught here, and a lost context disposes the
    // addon, which is xterm's own documented fallback. No `webgl.dispose()`
    // in the unmount cleanup: `term.dispose()` below already disposes
    // registered addons, and a second dispose after context loss would throw.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable (headless GL, exhausted contexts): keep DOM renderer.
    }
    termRef.current = term
    mounted.set(tabId, term)

    // The two keys this app takes off xterm, each only when there is
    // something to put in its place: Shift+Return (replaced by ESC CR) and a
    // bare Up (offered to the history overlay). Returning `true` is xterm's
    // untouched behaviour, so every other branch leaves this terminal exactly
    // as it was before this handler existed.
    //
    // A modified Up is left alone because every combination already means
    // something. ⌥⌘↑ is this app's own pane navigation, in the window keydown
    // handler in `App.tsx`. The rest belong to the pane: read in
    // `node_modules/@xterm/xterm/lib/xterm.js` on 2026-08-06,
    // `evaluateKeyboardEvent` builds `(shiftKey?1:0)|(altKey?2:0)|(ctrlKey?4:0)|(metaKey?8:0)`
    // and `case 38` emits `ESC[1;<that+1>A` whenever it is non-zero, so ⇧↑, ⌃↑
    // and ⌥↑ are each a DISTINCT sequence sent to whatever is running in the
    // pane. Swallowing one would take a keystroke away from that program.
    // (⌘↑ is the exception xterm makes for itself: `case 38` breaks on
    // `metaKey` and sends nothing at all.)
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
        return false
      }
      if (event.key !== 'ArrowUp') return true
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true
      return !historyRef.current(tabId)
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
      inputDisposable.dispose()
      offData()
      term.dispose()
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

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitRef.current?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  // Typing has to land in the pane the app says is active, or it goes to
  // whichever terminal happened to hold focus. This only ever takes focus, and
  // only on the way in: nothing here blurs a pane, and a pane that is not on
  // screen is never asked for focus because the caller passes false for one.
  useEffect(() => {
    if (!focused) return
    termRef.current?.focus()
  }, [focused])

  return <div data-testid="terminal" ref={containerRef} className="h-full w-full" />
}
