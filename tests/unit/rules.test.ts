import { describe, it, expect } from 'vitest'
import { inQuietHours, resolve } from '../../src/main/notify/rules'
import { DEFAULT_NOTIFICATIONS } from '../../src/main/state/store'
import type { NotificationConfig } from '../../src/shared/ipc'

const AFTERNOON = new Date('2026-07-30T14:00:00')

function config(partial: Partial<NotificationConfig> = {}): NotificationConfig {
  return { rules: [], muteWhenFocused: true, quietHours: null, ...partial }
}

describe('resolve', () => {
  it('says nothing when no rule matches', () => {
    expect(
      resolve(config(), { state: 'thinking', projectId: 'p1', attended: false, now: AFTERNOON }),
    ).toEqual({ toast: false, sound: null, urgency: 'low' })
  })

  it('applies a rule matching the state', () => {
    const rules = config({ rules: [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }] })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'p1', attended: false, now: AFTERNOON }),
    ).toEqual({ toast: true, sound: 'Funk', urgency: 'high' })
  })

  it('ignores a rule for a different state', () => {
    const rules = config({ rules: [{ on: 'idle', toast: true }] })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'p1', attended: false, now: AFTERNOON }).toast,
    ).toBe(false)
  })

  it('treats a rule with no `on` as matching every state', () => {
    const rules = config({ rules: [{ toast: true, urgency: 'high' }] })

    expect(
      resolve(rules, { state: 'ended', projectId: 'p1', attended: false, now: AFTERNOON }).toast,
    ).toBe(true)
  })

  it('lets a later rule override an earlier one', () => {
    const rules = config({
      rules: [
        { on: 'idle', toast: true, sound: 'Glass' },
        { on: 'idle', toast: false },
      ],
    })

    const outcome = resolve(rules, {
      state: 'idle',
      projectId: 'p1',
      attended: false,
      now: AFTERNOON,
    })

    // Only what the later rule states is overridden — it says nothing about
    // sound, so the earlier rule's sound stands.
    expect(outcome.toast).toBe(false)
    expect(outcome.sound).toBe('Glass')
  })

  it('lets a project rule beat a global one declared after it', () => {
    const rules = config({
      rules: [
        { on: 'idle', project: 'lumio', toast: false },
        { on: 'idle', toast: true },
      ],
    })

    // Both orderings from the spec are in play here. Project-scoped wins
    // regardless of position, which is why globals are applied first.
    expect(
      resolve(rules, { state: 'idle', projectId: 'lumio', attended: false, now: AFTERNOON }).toast,
    ).toBe(false)
    expect(
      resolve(rules, { state: 'idle', projectId: 'gco', attended: false, now: AFTERNOON }).toast,
    ).toBe(true)
  })

  it('lets a later project rule override an earlier project rule', () => {
    const rules = config({
      rules: [
        { on: 'waiting', project: 'lumio', toast: true },
        { on: 'waiting', project: 'lumio', toast: false },
      ],
    })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'lumio', attended: false, now: AFTERNOON })
        .toast,
    ).toBe(false)
  })

  it('never applies a project rule to a tab with no project', () => {
    const rules = config({ rules: [{ on: 'waiting', project: 'lumio', toast: true }] })

    // An Unsorted tab has no project row to be scoped by.
    expect(
      resolve(rules, { state: 'waiting', projectId: null, attended: false, now: AFTERNOON }).toast,
    ).toBe(false)
  })

  it('mutes the toast for the tab you are already looking at', () => {
    const rules = config({ rules: [{ on: 'waiting', toast: true, sound: 'Funk' }] })

    const outcome = resolve(rules, {
      state: 'waiting',
      projectId: 'p1',
      attended: true,
      now: AFTERNOON,
    })

    expect(outcome.toast).toBe(false)
    // The sound still plays: a chime for the pane in front of you is the
    // cheapest possible signal, and it is the popup that is redundant.
    expect(outcome.sound).toBe('Funk')
  })

  it('does not mute when muteWhenFocused is off', () => {
    const rules = config({
      rules: [{ on: 'waiting', toast: true }],
      muteWhenFocused: false,
    })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'p1', attended: true, now: AFTERNOON }).toast,
    ).toBe(true)
  })

  it('silences everything during quiet hours', () => {
    const rules = config({
      rules: [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }],
      quietHours: { from: '22:00', to: '07:00' },
    })

    const outcome = resolve(rules, {
      state: 'waiting',
      projectId: 'p1',
      attended: false,
      now: new Date('2026-07-30T23:30:00'),
    })

    expect(outcome).toEqual({ toast: false, sound: null, urgency: 'low' })
  })

  it('leaves the shipped defaults silent', () => {
    const outcome = resolve(DEFAULT_NOTIFICATIONS, {
      state: 'waiting',
      projectId: 'p1',
      attended: false,
      now: AFTERNOON,
    })

    expect(outcome.toast).toBe(true)
    // Sound is off out of the box because this machine's settings.json
    // already plays Funk on Notification and Glass on Stop.
    expect(outcome.sound).toBeNull()
    expect(outcome.urgency).toBe('high')
  })

  it('does not mutate the config it was given', () => {
    const rules = config({ rules: [{ on: 'waiting', toast: true }] })
    const snapshot = JSON.parse(JSON.stringify(rules))

    resolve(rules, { state: 'waiting', projectId: 'p1', attended: false, now: AFTERNOON })

    expect(rules).toEqual(snapshot)
  })
})

describe('inQuietHours', () => {
  it('is false when none are set', () => {
    expect(inQuietHours(null, AFTERNOON)).toBe(false)
  })

  it('handles a window inside one day', () => {
    const window = { from: '09:00', to: '17:00' }
    expect(inQuietHours(window, new Date('2026-07-30T12:00:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T08:59:00'))).toBe(false)
    expect(inQuietHours(window, new Date('2026-07-30T17:30:00'))).toBe(false)
  })

  it('handles a window that wraps past midnight', () => {
    const window = { from: '22:00', to: '07:00' }
    expect(inQuietHours(window, new Date('2026-07-30T23:30:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T02:00:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T12:00:00'))).toBe(false)
  })

  it('is inclusive of the start and exclusive of the end', () => {
    const window = { from: '22:00', to: '07:00' }
    expect(inQuietHours(window, new Date('2026-07-30T22:00:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T07:00:00'))).toBe(false)
  })

  it('ignores a window it cannot parse rather than silencing everything', () => {
    // A hand-edited config must not be able to mute the app permanently in a
    // way nothing explains.
    expect(inQuietHours({ from: 'evening', to: 'morning' }, AFTERNOON)).toBe(false)
    expect(inQuietHours({ from: '25:00', to: '07:00' }, AFTERNOON)).toBe(false)
  })
})
