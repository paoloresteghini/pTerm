import { describe, it, expect } from 'vitest'
import {
  HOOK_EVENTS,
  stateForExit,
  stateForHook,
  stateForOpen,
  type HookEvent,
} from '../../src/main/status/machine'
import { SEVERITY, type TabState } from '../../src/shared/status'

describe('stateForHook', () => {
  // The table, spelled out rather than generated. If one of these is wrong the
  // whole app lies about what a session is doing, and a generated expectation
  // would just restate the implementation.
  const table: Record<HookEvent, TabState> = {
    SessionStart: 'idle',
    UserPromptSubmit: 'thinking',
    PreToolUse: 'thinking',
    PostToolUse: 'thinking',
    Notification: 'waiting',
    Stop: 'idle',
    SessionEnd: 'unknown',
  }

  for (const [event, expected] of Object.entries(table)) {
    it(`maps ${event} to ${expected}`, () => {
      expect(stateForHook(event as HookEvent)).toBe(expected)
    })
  }

  it('has an entry for every subscribed event', () => {
    for (const event of HOOK_EVENTS) {
      expect(SEVERITY).toContain(stateForHook(event))
    }
    expect(Object.keys(table).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  // The rule from the parent spec, checked as a property rather than trusted:
  // Notification is the only way into `waiting`, so a tab cannot get stuck
  // there while Claude is working.
  it('reaches waiting only through Notification', () => {
    for (const event of HOOK_EVENTS) {
      if (event === 'Notification') continue
      expect(stateForHook(event)).not.toBe('waiting')
    }
  })
})

describe('stateForExit', () => {
  it('reads zero as a clean end', () => {
    expect(stateForExit(0)).toBe('ended')
  })

  it('reads anything else as a crash', () => {
    expect(stateForExit(1)).toBe('crashed')
    expect(stateForExit(130)).toBe('crashed')
    expect(stateForExit(-1)).toBe('crashed')
  })
})

describe('stateForOpen', () => {
  // A claude tab that has produced no events yet is the one case where a
  // hollow dot earns its place: it makes a broken hook install visible
  // instead of silent.
  it('starts a claude tab expecting hooks', () => {
    expect(stateForOpen('claude')).toBe('unknown')
  })

  it('starts a preset tab running', () => {
    expect(stateForOpen('preset')).toBe('running')
  })

  // Not `unknown`: a row of hollow dots on every shell trains you to ignore
  // the affordance the milestone needs you to trust. A shell gets a dot only
  // once something in it has said something.
  it('gives a shell tab no state at all', () => {
    expect(stateForOpen('shell')).toBeNull()
  })
})
