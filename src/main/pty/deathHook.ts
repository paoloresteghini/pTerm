/**
 * Anything that would change meaning on the way to the shell.
 *
 * The string this guards is interpolated into a tmux command, which re-parses
 * it when the hook fires, and then into a `/bin/sh` command inside that. So it
 * has to survive two parsers: `"` `$` `` ` `` `\` and a newline are the shell's,
 * `'` ends the quoting this uses to keep a path with a space in it whole, and
 * `#` opens a tmux format expansion — this command is deliberately full of
 * those, so a `#` arriving from a path would be expanded rather than printed.
 *
 * `install.ts` has a guard of its own (`UNSAFE_IN_PATH`) and it is not this
 * one: it covers the socket and spool paths rather than the script's, and its
 * charset has no single quote in it.
 */
const UNSAFE_IN_HOOK = /['"$`\\\n#]/

/** The ids this app generates. The hook script requires the same shape. */
const TAB_ID_RE = /^[0-9a-f]{16}$/

/** A tmux window id. Baked in literally: formats are not expanded here. */
const WINDOW_ID_RE = /^@\d+$/

/**
 * The tmux command run when a pane dies: report the status, then reap.
 *
 * Null when anything going into it could change the command's meaning — the
 * caller then installs no hook at all, which costs a red dot and nothing else.
 * These values come from `hookPaths()` and `newSessionId()`, so this should
 * never fire; the failure it prevents is arbitrary shell execution driven by a
 * home directory's name, which is worth a guard rather than an assumption.
 */
export function deathHookCommand(input: {
  reporter: string
  tabId: string
  tmuxSession: string
  windowId: string | null
}): string | null {
  if (UNSAFE_IN_HOOK.test(input.reporter)) return null
  if (!TAB_ID_RE.test(input.tabId)) return null
  if (UNSAFE_IN_HOOK.test(input.tmuxSession)) return null
  if (input.windowId !== null && !WINDOW_ID_RE.test(input.windowId)) return null

  // The reporter is single-quoted so a path with a space in it stays one word,
  // and both formats are expanded by tmux when the hook fires — quoted for the
  // shell, not hidden from tmux.
  //
  // Both halves are always asked for, because tmux fills in exactly one: a
  // status with no signal, or a signal *name* with no status. Asking only for
  // the status is what left a segfault or an OOM kill reporting nothing.
  const report =
    `PRCLI_TAB_ID=${input.tabId} '${input.reporter}' Exit ` +
    `'#{pane_dead_status}' '#{pane_dead_signal}'`

  // When windowId is null, the session is not yet window-scoped; use the
  // pre-M2c form. Once Task 2 provides the window id, this will emit the
  // scoped form that kills the window instead of the whole session.
  if (input.windowId === null) {
    return `run-shell "${report}" ; kill-session -t =${input.tmuxSession}`
  }

  return (
    `run-shell "${report}" ; kill-session -t =${input.tmuxSession} ; ` +
    `kill-window -t ${input.windowId}`
  )
}
