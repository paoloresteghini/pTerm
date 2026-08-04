import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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

export function Terminal({
  tabId,
  visible,
  /** Whether this pane is the one the keyboard is talking to. */
  focused,
  /** This pane's background. `PANE_COLOR_DEFAULT` when it has none of its own. */
  color,
}: {
  tabId: string
  visible: boolean
  focused: boolean
  color: PaneColor
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const termRef = useRef<XTerm | null>(null)

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
    termRef.current = term
    mounted.set(tabId, term)

    const offData = window.prcli.onData(({ id, data }) => {
      if (id === tabId) term.write(data)
    })
    const inputDisposable = term.onData((data) => window.prcli.input(tabId, data))

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
      window.prcli.resize(tabId, term.cols, term.rows)
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
