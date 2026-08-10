import { FALLBACK_DIRS, resolveBin } from '../bin/resolve'

/**
 * Where tmux lives when `PATH` doesn't say. Kept as its own export because
 * the tests here pin the Finder/Dock case against it by name; the list itself
 * is the shared one, and the reason it exists is documented on `FALLBACK_DIRS`.
 */
export const TMUX_FALLBACK_DIRS = FALLBACK_DIRS

/**
 * Absolute path to a usable tmux, or `'tmux'` when none is found — leaving the
 * adapter to raise TmuxNotInstalledError, which is the caller's cue to tell the
 * user how to install it.
 *
 * `PTERM_TMUX_BIN` overrides everything, for a non-standard install.
 */
export function resolveTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirs: readonly string[] = TMUX_FALLBACK_DIRS,
): string {
  const override = env.PTERM_TMUX_BIN
  if (override) return override
  return resolveBin('tmux', env, fallbackDirs)
}
