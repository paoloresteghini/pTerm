import { describe, it, expect } from 'vitest'
import { agentOwnersOf, releaseAgentSession } from '../../src/main/ipc/register'
import type { TabDescriptor } from '../../src/shared/ipc'

function pane(overrides: Partial<TabDescriptor> & Pick<TabDescriptor, 'id' | 'type'>): TabDescriptor {
  return { projectSlug: 'demo', cwd: '/Users/paolo/demo', ...overrides }
}

/**
 * `releaseAgentSession`'s own logic, pinned without a real Electron host near
 * it, the same reason `carveRatio.test.ts` and `claimForDeath.test.ts` test
 * their functions directly rather than through `registerIpc`. This is the
 * mechanism `CHANNELS.closePane` and `CHANNELS.dismissTab` call so that a
 * closed or dismissed agent session releases the browser pane it owned
 * without touching the browser pane itself.
 */
describe('releaseAgentSession', () => {
  it('clears every entry owned by the given session, leaving other owners alone', () => {
    const agentSessions = new Map([
      ['browser-1', 'session-a'],
      ['browser-2', 'session-a'],
      ['browser-3', 'session-b'],
    ])

    releaseAgentSession(agentSessions, 'session-a')

    expect(agentSessions.has('browser-1')).toBe(false)
    expect(agentSessions.has('browser-2')).toBe(false)
    // The other session's ownership survives. A mutant that cleared the
    // whole map, rather than only the matching entries, would fail this.
    expect(agentSessions.get('browser-3')).toBe('session-b')
  })

  it('is a no-op for a session that owns nothing', () => {
    const agentSessions = new Map([['browser-1', 'session-a']])

    releaseAgentSession(agentSessions, 'session-z')

    expect(agentSessions.get('browser-1')).toBe('session-a')
  })

  it('also clears the entry when the id passed is the browser pane itself, not its owning session', () => {
    // CHANNELS.dismissTab and CHANNELS.closePane pass the id of whatever pane
    // just closed, which is a browser pane's own key exactly when the user
    // closes that pane directly rather than closing its owning session pane.
    const agentSessions = new Map([['browser-1', 'session-a']])

    releaseAgentSession(agentSessions, 'browser-1')

    expect(agentSessions.has('browser-1')).toBe(false)
  })
})

/**
 * The other half of the same map: what `CHANNELS.restore` puts back on the
 * rows it answers with, and the reason a session that died rather than being
 * dismissed cannot leave a browser pane marked for it.
 *
 * `releaseAgentSession` above is called from two user gestures only. A Claude
 * session that exits calls `forgetTab` instead, which drops its pane's config
 * row while the map entry naming it survives, so the list `agentOwnersOf` is
 * handed after a ⌘R no longer contains the owner. The first test below is the
 * one that fails without the presence check; the second is its control.
 */
describe('agentOwnersOf', () => {
  it('leaves a browser pane unmarked when its owner is not in the list', () => {
    const agentSessions = new Map([['browser-1', 'session-a']])
    // No `session-a` row: this is the list restore builds after that session
    // exited and `forgetTab` dropped it from config.
    const panes = [pane({ id: 'browser-1', type: 'browser' })]

    expect(agentOwnersOf(agentSessions, panes)).toEqual([pane({ id: 'browser-1', type: 'browser' })])
  })

  it('marks a browser pane whose owner is still in the list', () => {
    const agentSessions = new Map([['browser-1', 'session-a']])
    const panes = [pane({ id: 'session-a', type: 'claude' }), pane({ id: 'browser-1', type: 'browser' })]

    expect(agentOwnersOf(agentSessions, panes)).toEqual([
      pane({ id: 'session-a', type: 'claude' }),
      pane({ id: 'browser-1', type: 'browser', agentSessionId: 'session-a' }),
    ])
  })

  it('marks only the panes the map names, and copies rather than mutating', () => {
    const agentSessions = new Map([['browser-1', 'session-a']])
    const untouched = pane({ id: 'browser-2', type: 'browser' })
    const panes = [pane({ id: 'session-a', type: 'claude' }), untouched]

    const result = agentOwnersOf(agentSessions, panes)

    expect(result[1]).toBe(untouched)
    expect(untouched.agentSessionId).toBeUndefined()
  })
})
