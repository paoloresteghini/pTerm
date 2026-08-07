import { describe, it, expect, vi } from 'vitest'
import { createMutationGuard } from '../../src/renderer/lib/mutationGuard'

describe('createMutationGuard', () => {
  it('clears busy when a mutation settles normally', () => {
    const setBusy = vi.fn()
    const guard = createMutationGuard(setBusy)
    const token = guard.started()
    expect(guard.isBusy()).toBe(true)
    guard.settled(token)
    expect(guard.isBusy()).toBe(false)
    expect(setBusy.mock.calls).toEqual([[true], [false]])
  })

  // This is the reported bug: a mutation left in flight when the project
  // changes must not strand `busy`. Before `projectSwitched` existed, nothing
  // freed `busy` except the abandoned call's own `.finally()`, which never
  // ran its clear because the guard it checked never matched again.
  it('frees busy on a project switch, with the mutation still in flight', () => {
    const setBusy = vi.fn()
    const guard = createMutationGuard(setBusy)
    guard.started()
    expect(guard.isBusy()).toBe(true)
    guard.projectSwitched()
    expect(guard.isBusy()).toBe(false)
  })

  it('a stale settle after a project switch does not reassert busy', () => {
    const setBusy = vi.fn()
    const guard = createMutationGuard(setBusy)
    const staleToken = guard.started()
    guard.projectSwitched()
    guard.settled(staleToken)
    expect(guard.isBusy()).toBe(false)
  })

  // The switch-back case: a call from the earlier visit to a project must not
  // be read as current just because the project id (tracked by the caller,
  // not this guard) happens to match again. Each visit gets its own
  // generation, so a token from a visit that has ended stays stale.
  it('a stale settle does not clobber a fresh mutation for a revisited project', () => {
    const setBusy = vi.fn()
    const guard = createMutationGuard(setBusy)
    const staleToken = guard.started() // first visit's mutation
    guard.projectSwitched() // switch away
    guard.projectSwitched() // switch back to the same project id
    guard.started() // a fresh mutation on the revisit
    guard.settled(staleToken) // the abandoned first call finally resolves
    expect(guard.isBusy()).toBe(true) // the fresh mutation is still open
  })

  it('isCurrent tells a fresh token from a stale one across a switch', () => {
    const guard = createMutationGuard(() => {})
    const token = guard.started()
    expect(guard.isCurrent(token)).toBe(true)
    guard.projectSwitched()
    expect(guard.isCurrent(token)).toBe(false)
  })
})
