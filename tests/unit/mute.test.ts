import { describe, it, expect } from 'vitest'
import { projectMuted, toggleProjectMute } from '../../src/renderer/mute'
import type { Rule } from '../../src/shared/ipc'

describe('projectMuted', () => {
  it('is false with no rules at all', () => {
    expect(projectMuted([], 'p1')).toBe(false)
  })

  it('is true once the exact mute rule is present', () => {
    const rules: Rule[] = [{ project: 'p1', toast: false }]
    expect(projectMuted(rules, 'p1')).toBe(true)
  })

  it('does not answer for a different project', () => {
    const rules: Rule[] = [{ project: 'p1', toast: false }]
    expect(projectMuted(rules, 'p2')).toBe(false)
  })

  // A global rule has no `project` at all, so it can never satisfy the
  // per-project shape this reads for.
  it('does not mistake a global toast-off rule for a project mute', () => {
    const rules: Rule[] = [{ on: 'idle', toast: false }]
    expect(projectMuted(rules, 'p1')).toBe(false)
  })

  // Muting is global-to-the-project (`on` absent). A rule scoped to one state
  // is a different feature, owned by the settings pane, not the sidebar.
  it('does not mistake a per-state project rule for the project mute', () => {
    const rules: Rule[] = [{ on: 'waiting', project: 'p1', toast: false }]
    expect(projectMuted(rules, 'p1')).toBe(false)
  })
})

describe('toggleProjectMute', () => {
  it('appends the mute rule when unmuted', () => {
    const after = toggleProjectMute([], 'p1')
    expect(after).toEqual([{ project: 'p1', toast: false }])
  })

  it('removes the mute rule when muted', () => {
    const rules: Rule[] = [{ project: 'p1', toast: false }]
    expect(toggleProjectMute(rules, 'p1')).toEqual([])
  })

  it('round-trips: two toggles restore the original array', () => {
    const original: Rule[] = [{ on: 'waiting', toast: true, sound: null, urgency: 'high' }]
    const once = toggleProjectMute(original, 'p1')
    const twice = toggleProjectMute(once, 'p1')
    expect(twice).toEqual(original)
  })

  it('leaves every other rule untouched, including one for the same project', () => {
    const other: Rule = { on: 'waiting', project: 'p1', toast: true }
    const global: Rule = { on: 'crashed', toast: true, sound: 'Funk', urgency: 'high' }
    const after = toggleProjectMute([other, global], 'p1')
    expect(after).toContainEqual(other)
    expect(after).toContainEqual(global)
    expect(after).toHaveLength(3)
  })

  // A rule with `project: undefined` (a global rule) must survive a mute
  // toggle for any project id untouched — the fix for the "clobber a global
  // rule" concern.
  it('does not clobber a global rule when muting a project', () => {
    const global: Rule = { toast: false, sound: null, urgency: 'low' }
    const after = toggleProjectMute([global], 'p1')
    expect(after).toContainEqual(global)
    expect(after).toHaveLength(2)
  })

  it('collapses duplicate mute rules on a single unmute', () => {
    const rules: Rule[] = [
      { project: 'p1', toast: false },
      { project: 'p1', toast: false },
    ]
    expect(toggleProjectMute(rules, 'p1')).toEqual([])
  })
})
