import { describe, it, expect } from 'vitest'
import { globalRuleOf, setGlobalRule } from '../../src/renderer/globalRule'
import type { Rule } from '../../src/shared/ipc'

describe('globalRuleOf', () => {
  it('is undefined when no rule names the state', () => {
    expect(globalRuleOf([], 'waiting')).toBeUndefined()
  })

  it('finds the global rule for a state', () => {
    const rules: Rule[] = [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }]
    expect(globalRuleOf(rules, 'waiting')).toEqual(rules[0])
  })

  // A project-scoped rule for the same state is a different row, owned by
  // the sidebar's mute toggle rather than this pane.
  it('does not answer with a project-scoped rule for the same state', () => {
    const rules: Rule[] = [{ on: 'waiting', project: 'p1', toast: false }]
    expect(globalRuleOf(rules, 'waiting')).toBeUndefined()
  })

  it('does not answer for a different state', () => {
    const rules: Rule[] = [{ on: 'idle', toast: true }]
    expect(globalRuleOf(rules, 'waiting')).toBeUndefined()
  })
})

describe('setGlobalRule', () => {
  it('appends a new rule when none exists for the state', () => {
    const after = setGlobalRule([], 'waiting', { toast: true })
    expect(after).toEqual([{ on: 'waiting', project: undefined, toast: true }])
  })

  it('replaces the existing global rule in place, not appending a second one', () => {
    const rules: Rule[] = [
      { on: 'idle', toast: true },
      { on: 'waiting', toast: false, sound: null, urgency: 'low' },
      { on: 'crashed', toast: true },
    ]

    const after = setGlobalRule(rules, 'waiting', { toast: true, sound: 'Funk' })

    expect(after).toHaveLength(3)
    expect(after[1]).toEqual({ on: 'waiting', project: undefined, toast: true, sound: 'Funk', urgency: 'low' })
    // Neighbours are untouched, and order is preserved.
    expect(after[0]).toEqual(rules[0])
    expect(after[2]).toEqual(rules[2])
  })

  it('never touches a project-scoped rule for the same state', () => {
    const rules: Rule[] = [{ on: 'waiting', project: 'p1', toast: false }]

    const after = setGlobalRule(rules, 'waiting', { toast: true })

    // The project rule survives untouched, and a new global rule is appended.
    expect(after).toEqual([
      { on: 'waiting', project: 'p1', toast: false },
      { on: 'waiting', project: undefined, toast: true },
    ])
  })

  it('does not mutate the array it was given', () => {
    const rules: Rule[] = [{ on: 'waiting', toast: false }]
    const snapshot = JSON.parse(JSON.stringify(rules))

    setGlobalRule(rules, 'waiting', { toast: true })

    expect(rules).toEqual(snapshot)
  })
})
