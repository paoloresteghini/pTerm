import { describe, it, expect } from 'vitest'
import {
  HOOK_EVENTS,
  stateForDeath,
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

// tmux reports the two halves of a death separately, and never both:
// `#{pane_dead_status}` carries an exit status with `#{pane_dead_signal}`
// empty, or the signal's *name* — "kill", "segv" — with the status empty.
// Measured on tmux 3.7b. A segfault or an OOM kill therefore has no status at
// all, and reading a missing one as 0 would paint the crash grey.
describe('stateForDeath', () => {
  it('reads a non-zero status as a crash', () => {
    expect(stateForDeath({ status: 3 })).toBe('crashed')
  })

  it('reads a zero status as an ordinary end', () => {
    expect(stateForDeath({ status: 0 })).toBe('ended')
  })

  it('reads a killing signal as a crash, whatever the status says', () => {
    expect(stateForDeath({ signal: 'kill' })).toBe('crashed')
    expect(stateForDeath({ status: 0, signal: 'segv' })).toBe('crashed')
  })

  // Nothing should ever produce this — the parser refuses a death that
  // reports neither half — but guessing `ended` for a death nobody can
  // explain is the failure this whole change exists to remove.
  it('treats a death that explains nothing as a crash, not as an ordinary end', () => {
    expect(stateForDeath({})).toBe('crashed')
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
