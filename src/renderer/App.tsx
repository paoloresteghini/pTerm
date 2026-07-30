import { useEffect, useState } from 'react'
import { Terminal } from './Terminal'

export function App() {
  const [tabId, setTabId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const restored = await window.prcli.restore()
      if (cancelled) return
      if (restored.length > 0) {
        setTabId(restored[0].id)
        return
      }
      const tab = await window.prcli.open({
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
      })
      if (!cancelled) setTabId(tab.id)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#09090b', padding: 8 }}>
      {tabId ? <Terminal tabId={tabId} /> : null}
    </div>
  )
}
