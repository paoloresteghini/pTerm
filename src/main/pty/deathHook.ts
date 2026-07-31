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
 * Whether a hook could be built, asked without the window id.
 *
 * `PtySession.start()` has to decide whether to chain `remain-on-exit` into the
 * very command that creates a session, and it must decide before tmux has made
 * the window the hook will be scoped to. The two go on together or not at all,
 * so it asks this instead of guessing.
 *
 * Leaving the window id out costs nothing, because it is never the reason a
 * hook is refused: it comes back from tmux itself as `@<digits>`, and when tmux
 * will not name a window there is no session left to leave a stray behind
 * either.
 */
export function canBuildDeathHook(input: {
  reporter: string
  tabId: string
  tmuxSession: string
}): boolean {
  if (UNSAFE_IN_HOOK.test(input.reporter)) return false
  if (!TAB_ID_RE.test(input.tabId)) return false
  if (UNSAFE_IN_HOOK.test(input.tmuxSession)) return false
  return true
}

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
  windowId: string
}): string | null {
  if (!canBuildDeathHook(input)) return null
  if (!WINDOW_ID_RE.test(input.windowId)) return null

  // The order is `run-shell`, then `kill-session`, then `kill-window`, and it
  // is not free. A tmux command list aborts at the first failure — measured:
  //
  //   $ tmux kill-session -t '=prcli-gone-0000000000000000' ';' kill-window -t @1
  //   can't find session: prcli-gone-0000000000000000
  //   windows after: @0 @1        # @1 survived
  //
  // So putting `kill-session` first means any failure of it forfeits the
  // window reap. It still goes first, because the member's client must be gone
  // before its window is: measured, a member whose bound window dies first
  // falls back to a SIBLING's window and two xterms then render the same pane.
  //
  // The one way `kill-session` fails in practice is a name that has gone
  // stale, and the session name here is a literal — it does not follow a
  // rename. `SessionManager.moveTabToProject` therefore reinstalls this hook
  // itself, under the new name, before it returns.
  //
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

  return (
    `run-shell "${report}" ; kill-session -t =${input.tmuxSession} ; ` +
    `kill-window -t ${input.windowId}`
  )
}
