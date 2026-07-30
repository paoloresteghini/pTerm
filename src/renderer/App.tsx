import { useEffect, useState } from 'react'
import { Terminal } from './Terminal'

export function App() {
  const [tabId, setTabId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { tabs } = await window.prcli.restore()
      if (cancelled) return
      if (tabs.length > 0) {
        setTabId(tabs[0].id)
        return
      }
      const tab = await window.prcli.open({
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
      })
      if (!cancelled) setTabId(tab.id)
    })().catch((reason: unknown) => {
      // Without this the user gets a black window and no clue why.
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#09090b', padding: 8 }}>
      {error ? (
        <pre
          data-testid="startup-error"
          style={{
            color: '#f87171',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
          }}
        >
          Could not start a terminal:{'\n'}
          {error}
        </pre>
      ) : null}
      {tabId ? <Terminal tabId={tabId} /> : null}
    </div>
  )
}
