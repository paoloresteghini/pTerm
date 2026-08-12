import { useEffect, useState } from 'react'
import type { McpBridgeState } from '../../shared/ipc'
import { Button } from '../ui/Button'
import { errorMessage } from './errorMessage'

/**
 * The browser bridge's off switch, under the Hooks tab because it is the other
 * thing this app writes into a Claude session's world.
 *
 * Two buttons rather than a checkbox, mirroring `HooksSection`: the state is
 * read from disk on mount and replaced by whatever the call answers with, and
 * a control that only ever shows what main told it cannot drift from it the
 * way a checkbox driven by local state can.
 */
export function McpSection() {
  const [bridge, setBridge] = useState<McpBridgeState | null>(null)
  // Its own error, separate from the state's `error`: this one is a call that
  // failed, which should not happen (neither handler rejects), and the other
  // is a switch that is working as far as it could and has something to say
  // about it.
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Read on mount, like the hooks row above: the file can be edited by hand
  // between one opening of this pane and the next.
  useEffect(() => {
    let cancelled = false
    window.pterm
      .mcpBridgeState()
      .then((state) => {
        if (!cancelled) setBridge(state)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setBridge(null)
          setFailure(errorMessage(reason))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const set = (enabled: boolean): void => {
    setBusy(true)
    window.pterm
      .setMcpBridgeEnabled(enabled)
      .then((state) => {
        setBridge(state)
        setFailure(null)
      })
      .catch((reason: unknown) => setFailure(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-label">Browser bridge</span>
        <span data-testid="mcp-status" className="text-[11px] text-muted">
          {bridge ? (bridge.enabled ? 'on' : 'off') : '…'}
        </span>
      </div>

      <p className="mb-2 text-[11px] text-muted">
        Lets a Claude session running in a pane open loopback URLs in a browser pane of its own.
        Turning it off removes pTerm&apos;s entry from ~/.claude.json and stops the socket it
        serves on, so a session cannot reach it either way.
      </p>

      {failure ? (
        <p data-testid="mcp-error" className="mb-2 text-[11px] text-danger">
          {failure}
        </p>
      ) : null}
      {bridge?.error ? (
        <p data-testid="mcp-warning" className="mb-2 text-[11px] text-amber-400">
          {bridge.error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          data-testid="mcp-enable"
          disabled={busy || bridge === null || bridge.enabled}
          onClick={() => set(true)}
        >
          Turn on
        </Button>
        <Button
          data-testid="mcp-disable"
          disabled={busy || bridge === null || !bridge.enabled}
          onClick={() => set(false)}
        >
          Turn off
        </Button>
      </div>
    </section>
  )
}
