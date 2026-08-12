import { describe, it, expect } from 'vitest'
import { releaseAgentSession } from '../../src/main/ipc/register'

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
})
