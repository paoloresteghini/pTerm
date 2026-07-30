import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function Terminal({ tabId, visible }: { tabId: string; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<(() => void) | null>(null)

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
      theme: { background: '#09090b', foreground: '#d4d4d8' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    const offData = window.prcli.onData(({ id, data }) => {
      if (id === tabId) term.write(data)
    })
    const inputDisposable = term.onData((data) => window.prcli.input(tabId, data))

    const fitToContainer = (): void => {
      // A hidden container measures 0×0; fitting to that would resize the
      // real tmux session down to nothing.
      if (container.offsetParent === null) return
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
    }
  }, [tabId])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitRef.current?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return <div data-testid="terminal" ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
