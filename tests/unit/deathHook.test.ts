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
    })

    expect(command).toBe(
      `run-shell "PRCLI_TAB_ID=${ID} '/Users/paolo/.prcli/prcli-hook' Exit '#{pane_dead_status}'" ; ` +
        `kill-session -t =${SESSION}`,
    )
  })

  it('keeps a path with a space in it as one word', () => {
    const command = deathHookCommand({
      reporter: '/Users/paolo/Application Support/prcli-hook',
      tabId: ID,
      tmuxSession: SESSION,
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
    expect(deathHookCommand({ reporter, tabId: ID, tmuxSession: SESSION })).toBeNull()
  })

  it('refuses a tab id that is not sixteen hex characters', () => {
    expect(
      deathHookCommand({
        reporter: '/Users/paolo/.prcli/prcli-hook',
        tabId: "abc'; rm -rf /",
        tmuxSession: SESSION,
      }),
    ).toBeNull()
  })
})
