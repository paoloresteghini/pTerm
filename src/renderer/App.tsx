import { useCallback, useEffect, useReducer, useState } from 'react'
import { Terminal } from './Terminal'
import { TabBar } from './TabBar'
import { INITIAL_TABS_STATE, tabsReducer } from './tabs'

// Milestone 2b replaces this with real projects.
const SCRATCH_PROJECT = { projectSlug: 'scratch', cwd: '/Users/paolo/Code' }

export function App() {
  const [state, dispatch] = useReducer(tabsReducer, INITIAL_TABS_STATE)
  const [error, setError] = useState<string | null>(null)
  // Set once the workspace exists. Until then this window knows nothing about
  // which tab is active, and must not say anything about it — see the effect
  // below.
  const [ready, setReady] = useState(false)

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  // Neither of these reports the new active tab: the effect below does, for
  // every path at once. Closing a tab moves the active one too, and only the
  // reducer knows where to.
  const openTab = useCallback(() => {
    window.prcli.open(SCRATCH_PROJECT).then((tab) => dispatch({ type: 'opened', tab })).catch(fail)
  }, [fail])

  const activateTab = useCallback((id: string) => {
    dispatch({ type: 'activated', id })
  }, [])

  // Closing a tab destroys its session. Detaching instead would leave a
  // session running that the UI no longer lists — which is how sessions got
  // stranded before.
  const closeTab = useCallback(
    (id: string) => {
      window.prcli
        .kill(id)
        .then(() => dispatch({ type: 'removed', id }))
        .catch(fail)
    },
    [fail],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { tabs, activeTabId } = await window.prcli.restore()
      if (cancelled) return
      if (tabs.length > 0) {
        dispatch({ type: 'restored', tabs, activeId: activeTabId })
        setReady(true)
        return
      }
      const tab = await window.prcli.open(SCRATCH_PROJECT)
      if (cancelled) return
      dispatch({ type: 'opened', tab })
      setReady(true)
    })().catch((reason: unknown) => {
      // `ready` stays false: with no workspace there is no active tab to
      // report, and saying so would overwrite the one on disk.
      if (!cancelled) fail(reason)
    })
    return () => {
      cancelled = true
    }
  }, [fail])

  // The one place that tells the main process which tab is active, so that
  // every path is covered — including the ones nothing calls directly, like a
  // close or a death moving the active tab to a neighbour.
  //
  // The guard is what makes a single writer safe: on mount `activeId` is null,
  // and writing that would wipe the saved value the restore above is on its
  // way to read.
  useEffect(() => {
    if (!ready) return
    window.prcli.setActive(state.activeId)
  }, [ready, state.activeId])

  // A session that dies on its own must leave the tab bar with it — but a
  // client stopping is not a session dying. `Ctrl-b d` inside a pane, and the
  // detach restore does before it reattaches, both arrive here with the
  // session still running, and those tabs must stay.
  useEffect(
    () =>
      window.prcli.onExit(({ id, sessionAlive }) => {
        if (sessionAlive) return
        dispatch({ type: 'removed', id })
      }),
    [],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey) return
      if (event.key === 't') {
        event.preventDefault()
        openTab()
        return
      }
      if (event.key === 'w' && state.activeId) {
        event.preventDefault()
        closeTab(state.activeId)
        return
      }
      const digit = Number.parseInt(event.key, 10)
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const target = state.tabs[digit - 1]
        if (target) {
          event.preventDefault()
          activateTab(target.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.activeId, state.tabs, openTab, closeTab, activateTab])

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: '#09090b',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <TabBar
        tabs={state.tabs}
        activeId={state.activeId}
        onActivate={activateTab}
        onClose={closeTab}
        onNew={openTab}
      />
      {error ? (
        <pre
          data-testid="startup-error"
          style={{
            color: '#f87171',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            padding: 8,
            margin: 0,
          }}
        >
          {error}
        </pre>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* Every terminal stays mounted. Unmounting would dispose its xterm
            and lose local scrollback and viewport position on every switch. */}
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeId
          return (
            <div
              key={tab.id}
              data-testid={active ? 'terminal-active' : `terminal-${tab.id}`}
              style={{
                position: 'absolute',
                inset: 0,
                padding: 8,
                // `visibility` rather than `display`, so a hidden tab is still
                // laid out and can measure itself. A `display:none` one never
                // fits, so it attaches at 80×24 and tmux shrinks the real
                // session to match — every background tab, on every launch.
                visibility: active ? 'visible' : 'hidden',
                // Laid out means it would otherwise sit over the active tab
                // and swallow its clicks.
                pointerEvents: active ? 'auto' : 'none',
                zIndex: active ? 1 : 0,
              }}
            >
              <Terminal tabId={tab.id} visible={active} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
