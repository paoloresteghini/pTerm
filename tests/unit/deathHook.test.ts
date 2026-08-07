import { describe, it, expect } from 'vitest'
import { canBuildDeathHook, deathHookCommand } from '../../src/main/pty/deathHook'

const ID = '0123456789abcdef'
const SESSION = `pterm-alpha-${ID}`

/**
 * `PtySession.start()` has to decide whether to chain `remain-on-exit` into the
 * very command that creates a session, and it has to decide before tmux has
 * made the window the hook will name. It asks this rather than guessing — so
 * this function is the load-bearing half of the together-or-not-at-all rule at
 * spawn time, and it went the whole milestone with no test of its own.
 */
describe('canBuildDeathHook', () => {
  const safe = { reporter: '/Users/paolo/.pterm/pterm-hook', tabId: ID, tmuxSession: SESSION }

  it('accepts the values this app actually generates', () => {
    expect(canBuildDeathHook(safe)).toBe(true)
  })

  it.each([
    ["a single quote", "/Users/o'brien/.pterm/pterm-hook"],
    ['a double quote', '/Users/paolo/"x"/pterm-hook'],
    ['a dollar sign', '/Users/paolo/$HOME/pterm-hook'],
    ['a backtick', '/Users/paolo/`id`/pterm-hook'],
    ['a backslash', '/Users/paolo/x\\y/pterm-hook'],
    ['a newline', '/Users/paolo/x\ny/pterm-hook'],
    ['a hash', '/Users/paolo/#{x}/pterm-hook'],
  ])('refuses a reporter path containing %s', (_label, reporter) => {
    expect(canBuildDeathHook({ ...safe, reporter })).toBe(false)
  })

  it.each([
    ['a shell metacharacter', "abc'; rm -rf /"],
    ['nothing at all', ''],
    ['upper-case hex', 'A1B2C3D4E5F60718'],
    ['fifteen characters', 'a1b2c3d4e5f6071'],
    ['seventeen characters', 'a1b2c3d4e5f607180'],
  ])('refuses a tab id that is %s rather than sixteen hex characters', (_label, tabId) => {
    expect(canBuildDeathHook({ ...safe, tabId })).toBe(false)
  })

  // These are refused by `isPTermSession` because the third dash-separated
  // part isn't 16 hex characters, not because of any charset check — the
  // session name is no longer checked against the reporter's charset at all
  // (see `canBuildDeathHook`). It is not, however, the reason this guard
  // exists: `encodeSessionName` already refuses anything but `[a-z0-9_]` and
  // 16 hex, so nothing here is reachable from the app.
  it.each([
    ['a single quote', "pterm-alpha-'x'" ],
    ['a hash', 'pterm-alpha-#{x}'],
    ['a dollar sign', 'pterm-alpha-$x'],
  ])('refuses a session name containing %s', (_label, tmuxSession) => {
    expect(canBuildDeathHook({ ...safe, tmuxSession })).toBe(false)
  })

  it.each([
    ['a chained tmux command', 'pterm-alpha-a1b2c3d4e5f60718 ; kill-server'],
    ['an id half that is not hex', 'pterm-alpha-nothex'],
    ['no pterm prefix at all', 'not-a-pterm-name'],
    ['nothing at all', ''],
  ])('refuses a session name with %s, which this app could not have generated', (_l, tmuxSession) => {
    expect(
      deathHookCommand({
        reporter: '/tmp/pterm/pterm-hook',
        tabId: 'a1b2c3d4e5f60718',
        tmuxSession,
        windowId: '@7',
      }),
    ).toBeNull()
  })

  // The two must agree exactly, minus the window id, or the spawn-time
  // decision and the install-time one can disagree — `remain-on-exit` chained
  // on for a hook that is then refused, which is the stray this project has
  // already shipped once.
  it('answers what deathHookCommand will, for every input either of them judges', () => {
    const reporters = [
      '/Users/paolo/.pterm/pterm-hook',
      '/Users/paolo/Application Support/pterm-hook',
      "/Users/o'brien/.pterm/pterm-hook",
      '/Users/paolo/#{x}/pterm-hook',
      '/Users/paolo/$HOME/pterm-hook',
    ]
    const tabIds = [ID, 'a1b2c3d4e5f60718', "abc'; rm -rf /", '']
    const sessions = [SESSION, 'pterm-alpha-x ; kill-server']
    for (const reporter of reporters) {
      for (const tabId of tabIds) {
        for (const tmuxSession of sessions) {
          const input = { reporter, tabId, tmuxSession }
          expect({ ...input, ok: canBuildDeathHook(input) }).toEqual({
            ...input,
            ok: deathHookCommand({ ...input, windowId: '@7' }) !== null,
          })
        }
      }
    }
  })
})

describe('deathHookCommand', () => {
  it('reports the dead pane\'s status and then kills the session', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/.pterm/pterm-hook',
      tabId: ID,
      tmuxSession: SESSION,
      windowId: '@7',
    })

    expect(command).toBe(
      `run-shell "PTERM_TAB_ID=${ID} '/Users/paolo/.pterm/pterm-hook' Exit ` +
        `'#{pane_dead_status}' '#{pane_dead_signal}'" ; ` +
        `kill-session -t =${SESSION} ; kill-window -t @7`,
    )
  })

  // tmux fills in one or the other, so both are always passed and the script
  // decides. Asking for only the status is what left a signal-killed pane —
  // a segfault, an OOM kill — reporting nothing at all.
  it('asks for the signal as well as the status', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/.pterm/pterm-hook',
      tabId: ID,
      tmuxSession: SESSION,
      windowId: '@7',
    })

    expect(command).toContain("'#{pane_dead_signal}'")
  })

  it('keeps a path with a space in it as one word', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/Application Support/pterm-hook',
      tabId: ID,
      tmuxSession: SESSION,
      windowId: '@7',
    })

    expect(command).toContain("'/Users/paolo/Application Support/pterm-hook'")
  })

  // This string is interpolated into a tmux command, which re-parses it, and
  // then into a shell command inside that. `renderScript`'s own guard does not
  // cover it: that one checks the socket and spool paths, not the script's,
  // and its charset has no single quote in it — which is the exact character
  // that would end the quoting here.
  it.each([
    ["a single quote", "/Users/o'brien/.pterm/pterm-hook"],
    ['a double quote', '/Users/paolo/"x"/pterm-hook'],
    ['a dollar sign', '/Users/paolo/$HOME/pterm-hook'],
    ['a backtick', '/Users/paolo/`id`/pterm-hook'],
    ['a backslash', '/Users/paolo/x\\y/pterm-hook'],
    ['a newline', '/Users/paolo/x\ny/pterm-hook'],
    // `#` opens a tmux format expansion, not a shell comment, and this string
    // is deliberately full of them.
    ['a hash', '/Users/paolo/#{x}/pterm-hook'],
  ])('refuses a reporter path containing %s', (_label, reporter) => {
    expect(deathHookCommand({ reporter, tabId: ID, tmuxSession: SESSION, windowId: '@7' })).toBeNull()
  })

  it('refuses a tab id that is not sixteen hex characters', () => {
    expect(
      deathHookCommand({
        reporter: '/Users/paolo/.pterm/pterm-hook',
        tabId: "abc'; rm -rf /",
        tmuxSession: SESSION,
        windowId: '@7',
      }),
    ).toBeNull()
  })

  it('reaps the dying pane\'s window and member session, in that order', () => {
    const command = deathHookCommand({
      reporter: '/tmp/pterm/pterm-hook',
      tabId: 'a1b2c3d4e5f60718',
      tmuxSession: 'pterm-lumio-a1b2c3d4e5f60718',
      windowId: '@7',
    })
    // The member's client must be gone before its window is: a member whose
    // bound window dies first falls back to a SIBLING's window, and two xterms
    // then render the same pane. Measured 2026-07-31.
    expect(command).toBe(
      `run-shell "PTERM_TAB_ID=a1b2c3d4e5f60718 '/tmp/pterm/pterm-hook' Exit ` +
        `'#{pane_dead_status}' '#{pane_dead_signal}'" ; ` +
        `kill-session -t =pterm-lumio-a1b2c3d4e5f60718 ; kill-window -t @7`,
    )
  })

  // tmux does not expand formats in a command argument outside run-shell, so the
  // window id is baked in literally. A format arriving here would reach tmux
  // unexpanded and kill-window would fail with "-t expects an argument".
  it('refuses a window id that is not a literal @<digits>', () => {
    for (const windowId of ['#{window_id}', '@', '7', '@7;kill-server', '']) {
      expect(
        deathHookCommand({
          reporter: '/tmp/pterm/pterm-hook',
          tabId: 'a1b2c3d4e5f60718',
          tmuxSession: 'pterm-lumio-a1b2c3d4e5f60718',
          windowId: windowId as string,
        }),
      ).toBeNull()
    }
  })
})
