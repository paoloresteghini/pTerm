import { describe, it, expect } from 'vitest'
import {
  hookCommand,
  isInstalled,
  merge,
  soundCollisions,
  unmerge,
} from '../../src/main/hooks/install'
import { HOOK_EVENTS } from '../../src/main/status/machine'

const HOOK = '/Users/someone/.pterm/bin/pterm-hook'

/**
 * Modelled on the real ~/.claude/settings.json, not invented: twelve
 * top-level keys, five of the seven subscribed events already populated, a
 * matcher on PreToolUse, and two events holding more than one group. Those
 * are the four shapes the merge must not disturb.
 */
function realistic(): Record<string, unknown> {
  return {
    env: { SOME_KEY: 'value' },
    permissions: { allow: ['Bash(ls:*)'] },
    model: 'opusplan',
    statusLine: { type: 'command', command: 'statusline.sh' },
    enabledPlugins: { 'superpowers@obra': true },
    tui: { theme: 'dark' },
    skipDangerousModePermissionPrompt: true,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/someone/.claude/guard.sh' }] },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node "/Users/someone/.claude/update.js"' }] },
        { hooks: [{ type: 'command', command: '/Users/someone/.claude/session-update' }] },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'node "/Users/someone/.claude/monitor.js"' }] },
      ],
      Notification: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Funk.aiff' }] }],
      Stop: [
        { hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] },
        { hooks: [{ type: 'command', command: '/Users/someone/.claude/stop.sh' }] },
      ],
    },
  }
}

describe('merge', () => {
  it('adds an entry for every subscribed event', () => {
    const { next, added } = merge(realistic(), HOOK)

    expect([...added].sort()).toEqual([...HOOK_EVENTS].sort())
    const hooks = next.hooks as Record<string, unknown[]>
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event] ?? []
      const commands = groups.flatMap((group) =>
        ((group as { hooks?: { command?: string }[] }).hooks ?? []).map((h) => h.command),
      )
      expect(commands).toContain(hookCommand(HOOK, event))
    }
  })

  it('leaves every pre-existing group byte-identical', () => {
    const before = realistic()
    const { next } = merge(before, HOOK)

    const beforeHooks = before.hooks as Record<string, unknown[]>
    const afterHooks = next.hooks as Record<string, unknown[]>
    for (const [event, groups] of Object.entries(beforeHooks)) {
      // pTerm appends, so the originals must still be the leading elements in
      // the same order — a matcher intact, two groups still two groups.
      expect(afterHooks[event]?.slice(0, groups.length)).toEqual(groups)
    }
  })

  it('leaves every other top-level key untouched', () => {
    const before = realistic()
    const { next } = merge(before, HOOK)

    for (const key of Object.keys(before)) {
      if (key === 'hooks') continue
      expect(next[key]).toEqual(before[key])
    }
  })

  it('does not mutate the settings it was given', () => {
    const before = realistic()
    const snapshot = JSON.parse(JSON.stringify(before))
    merge(before, HOOK)
    expect(before).toEqual(snapshot)
  })

  it('is idempotent — a second merge adds nothing', () => {
    const once = merge(realistic(), HOOK)
    const twice = merge(once.next, HOOK)

    expect(twice.added).toEqual([])
    expect(twice.next).toEqual(once.next)
  })

  it('builds a hooks block from nothing when the file has none', () => {
    const { next, added } = merge({ model: 'opusplan' }, HOOK)

    expect(added).toHaveLength(HOOK_EVENTS.length)
    expect(next.model).toBe('opusplan')
    expect(Object.keys(next.hooks as object).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  it('treats a settings file that is not an object as an empty one', () => {
    expect(merge(null, HOOK).added).toHaveLength(HOOK_EVENTS.length)
    expect(merge('nonsense', HOOK).added).toHaveLength(HOOK_EVENTS.length)
    expect(merge([], HOOK).added).toHaveLength(HOOK_EVENTS.length)
  })

  it("gives pTerm's PreToolUse entry no matcher, so it sees every tool", () => {
    const { next } = merge(realistic(), HOOK)
    const groups = (next.hooks as Record<string, Record<string, unknown>[]>).PreToolUse ?? []
    const ours = groups.find((group) =>
      ((group.hooks ?? []) as { command?: string }[]).some(
        (h) => h.command === hookCommand(HOOK, 'PreToolUse'),
      ),
    )
    expect(ours).toBeDefined()
    expect(ours && 'matcher' in ours).toBe(false)
  })
})

describe('isInstalled', () => {
  it('is false before and true after', () => {
    expect(isInstalled(realistic(), HOOK)).toBe(false)
    expect(isInstalled(merge(realistic(), HOOK).next, HOOK)).toBe(true)
  })

  it('is false when only some events carry our entry', () => {
    const { next } = merge(realistic(), HOOK)
    const hooks = next.hooks as Record<string, unknown[]>
    delete hooks.Stop
    expect(isInstalled(next, HOOK)).toBe(false)
  })

  it('does not mistake another tool\'s hook for ours', () => {
    expect(isInstalled(realistic(), HOOK)).toBe(false)
  })
})

describe('unmerge', () => {
  it('removes exactly what merge added', () => {
    const before = realistic()
    const { next } = merge(before, HOOK)
    const { next: after, removed } = unmerge(next, HOOK)

    expect([...removed].sort()).toEqual([...HOOK_EVENTS].sort())
    expect(after).toEqual(before)
  })

  it('leaves an event array in place when something else is still in it', () => {
    const { next } = merge(realistic(), HOOK)
    const after = unmerge(next, HOOK).next
    const hooks = after.hooks as Record<string, unknown[]>
    expect(hooks.Stop).toHaveLength(2)
    expect(hooks.SessionStart).toHaveLength(2)
  })

  it('drops an event key entirely when ours was the only group in it', () => {
    const { next } = merge({ model: 'x' }, HOOK)
    const after = unmerge(next, HOOK).next
    // Leaving `SessionEnd: []` behind would be litter in a file the user reads.
    expect(after.hooks).toBeUndefined()
  })

  it('removes nothing when nothing of ours is there', () => {
    const before = realistic()
    const { next, removed } = unmerge(before, HOOK)
    expect(removed).toEqual([])
    expect(next).toEqual(before)
  })

  it('removes only the hook path it was given', () => {
    const other = '/Users/someone/.pterm-other/bin/pterm-hook'
    const both = merge(merge(realistic(), HOOK).next, other).next
    const after = unmerge(both, HOOK).next
    expect(isInstalled(after, HOOK)).toBe(false)
    expect(isInstalled(after, other)).toBe(true)
  })
})

describe('soundCollisions', () => {
  // This machine already plays Funk on Notification and Glass on Stop — two of
  // the three sounds the parent spec's default rules name. The install screen
  // names the collision rather than letting it be discovered by ear.
  it('finds afplay hooks on subscribed events', () => {
    const found = soundCollisions(realistic())
    expect(found.map((c) => c.event).sort()).toEqual(['Notification', 'Stop'])
    expect(found[0]?.command).toContain('afplay')
  })

  it('ignores afplay on an event pTerm does not subscribe to', () => {
    const settings = { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'afplay x' }] }] } }
    expect(soundCollisions(settings)).toEqual([])
  })

  it('finds nothing in a file with no hooks', () => {
    expect(soundCollisions({ model: 'x' })).toEqual([])
    expect(soundCollisions(null)).toEqual([])
  })
})

/**
 * `settings` is `unknown` for a reason: this file is not ours, and nothing
 * guarantees it holds well-formed groups by the time pTerm reads it. A
 * half-finished install, a hand edit, or a future Claude Code version could
 * leave a group with no `hooks` array, a `hooks` value that is itself an
 * object rather than an array, a `command` that isn't a string, or a bare
 * `null` sitting where a group should be. None of that is pTerm's to fix,
 * but none of it should be able to throw while merging, unmerging, or
 * checking install state either — it should just contribute nothing.
 */
describe('malformed hook shapes', () => {
  it('does not crash on a group whose hooks field is an object, not an array', () => {
    const settings = {
      hooks: { PreToolUse: [{ hooks: { type: 'command', command: '/x' } }] },
    }

    expect(() => merge(settings, HOOK)).not.toThrow()
    expect(() => isInstalled(settings, HOOK)).not.toThrow()
    expect(() => soundCollisions(settings)).not.toThrow()
    expect(isInstalled(settings, HOOK)).toBe(false)

    const { next, added } = merge(settings, HOOK)
    expect(added).toContain('PreToolUse')
    // The malformed group survives untouched, not silently dropped.
    const hooks = next.hooks as Record<string, unknown[]>
    expect(hooks.PreToolUse?.[0]).toEqual({ hooks: { type: 'command', command: '/x' } })
  })

  it('does not crash on a hook entry whose command is not a string', () => {
    const settings = {
      hooks: { Notification: [{ hooks: [{ type: 'command', command: 42 }] }] },
    }

    expect(() => merge(settings, HOOK)).not.toThrow()
    expect(() => unmerge(settings, HOOK)).not.toThrow()
    expect(() => isInstalled(settings, HOOK)).not.toThrow()
    expect(() => soundCollisions(settings)).not.toThrow()
    expect(isInstalled(settings, HOOK)).toBe(false)
    expect(soundCollisions(settings)).toEqual([])
  })

  it('does not crash on a bare null sitting where a group should be', () => {
    const settings = { hooks: { Stop: [null, 'garbage', 42] } }

    expect(() => merge(settings, HOOK)).not.toThrow()
    expect(() => unmerge(settings, HOOK)).not.toThrow()
    expect(() => isInstalled(settings, HOOK)).not.toThrow()
    expect(() => soundCollisions(settings)).not.toThrow()
    expect(isInstalled(settings, HOOK)).toBe(false)
  })

  it("does not mistake a different tool's path for ours by prefix alone", () => {
    // hookCommand quotes the path, so a match requires the closing quote too —
    // an unrelated tool whose path merely starts with ours must not count.
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: `"${HOOK}-other-tool" PreToolUse` }] },
        ],
      },
    }
    expect(isInstalled(settings, HOOK)).toBe(false)
    const { added } = merge(settings, HOOK)
    expect(added).toContain('PreToolUse')
  })
})
