import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function Terminal({ tabId }: { tabId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

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
    fit.fit()

    const offData = window.prcli.onData(({ id, data }) => {
      if (id === tabId) term.write(data)
    })
    const inputDisposable = term.onData((data) => window.prcli.input(tabId, data))

    // Tell the PTY our real size once xterm has measured itself.
    window.prcli.resize(tabId, term.cols, term.rows)

    const observer = new ResizeObserver(() => {
      fit.fit()
      window.prcli.resize(tabId, term.cols, term.rows)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      offData()
      term.dispose()
    }
  }, [tabId])

  return <div data-testid="terminal" ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
