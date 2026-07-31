import { describe, it, expect } from 'vitest'
import { deathHookCommand } from '../../src/main/pty/deathHook'

const ID = '0123456789abcdef'
const SESSION = `prcli-alpha-${ID}`

describe('deathHookCommand', () => {
  it('reports the dead pane\'s status and then kills the session', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/.prcli/prcli-hook',
      tabId: ID,
      tmuxSession: SESSION,
      windowId: '@7',
    })

    expect(command).toBe(
      `run-shell "PRCLI_TAB_ID=${ID} '/Users/paolo/.prcli/prcli-hook' Exit ` +
        `'#{pane_dead_status}' '#{pane_dead_signal}'" ; ` +
        `kill-session -t =${SESSION} ; kill-window -t @7`,
    )
  })

  // tmux fills in one or the other, so both are always passed and the script
  // decides. Asking for only the status is what left a signal-killed pane —
  // a segfault, an OOM kill — reporting nothing at all.
  it('asks for the signal as well as the status', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/.prcli/prcli-hook',
      tabId: ID,
      tmuxSession: SESSION,
      windowId: '@7',
    })

    expect(command).toContain("'#{pane_dead_signal}'")
  })

  it('keeps a path with a space in it as one word', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/Application Support/prcli-hook',
      tabId: ID,
      tmuxSession: SESSION,
      windowId: '@7',
    })

    expect(command).toContain("'/Users/paolo/Application Support/prcli-hook'")
  })

  // This string is interpolated into a tmux command, which re-parses it, and
  // then into a shell command inside that. `renderScript`'s own guard does not
  // cover it: that one checks the socket and spool paths, not the script's,
  // and its charset has no single quote in it — which is the exact character
  // that would end the quoting here.
  it.each([
    ["a single quote", "/Users/o'brien/.prcli/prcli-hook"],
    ['a double quote', '/Users/paolo/"x"/prcli-hook'],
    ['a dollar sign', '/Users/paolo/$HOME/prcli-hook'],
    ['a backtick', '/Users/paolo/`id`/prcli-hook'],
    ['a backslash', '/Users/paolo/x\\y/prcli-hook'],
    ['a newline', '/Users/paolo/x\ny/prcli-hook'],
    // `#` opens a tmux format expansion, not a shell comment, and this string
    // is deliberately full of them.
    ['a hash', '/Users/paolo/#{x}/prcli-hook'],
  ])('refuses a reporter path containing %s', (_label, reporter) => {
    expect(deathHookCommand({ reporter, tabId: ID, tmuxSession: SESSION, windowId: '@7' })).toBeNull()
  })

  it('refuses a tab id that is not sixteen hex characters', () => {
    expect(
      deathHookCommand({
        reporter: '/Users/paolo/.prcli/prcli-hook',
        tabId: "abc'; rm -rf /",
        tmuxSession: SESSION,
        windowId: '@7',
      }),
    ).toBeNull()
  })

  it('reaps the dying pane\'s window and member session, in that order', () => {
    const command = deathHookCommand({
      reporter: '/tmp/prcli/prcli-hook',
      tabId: 'a1b2c3d4e5f60718',
      tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
      windowId: '@7',
    })
    // The member's client must be gone before its window is: a member whose
    // bound window dies first falls back to a SIBLING's window, and two xterms
    // then render the same pane. Measured 2026-07-31.
    expect(command).toBe(
      `run-shell "PRCLI_TAB_ID=a1b2c3d4e5f60718 '/tmp/prcli/prcli-hook' Exit ` +
        `'#{pane_dead_status}' '#{pane_dead_signal}'" ; ` +
        `kill-session -t =prcli-lumio-a1b2c3d4e5f60718 ; kill-window -t @7`,
    )
  })

  // tmux does not expand formats in a command argument outside run-shell, so the
  // window id is baked in literally. A format arriving here would reach tmux
  // unexpanded and kill-window would fail with "-t expects an argument".
  it('refuses a window id that is not a literal @<digits>', () => {
    for (const windowId of ['#{window_id}', '@', '7', '@7;kill-server', '']) {
      expect(
        deathHookCommand({
          reporter: '/tmp/prcli/prcli-hook',
          tabId: 'a1b2c3d4e5f60718',
          tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
          windowId,
        }),
      ).toBeNull()
    }
  })
})
