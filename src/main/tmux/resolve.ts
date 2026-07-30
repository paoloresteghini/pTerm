import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Where tmux lives when `PATH` doesn't say. An app launched from Finder or the
 * Dock inherits launchd's `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — not the
 * one from your shell profile, so a Homebrew tmux is invisible to it. Every
 * test and every `npm start` runs from a shell that already has Homebrew on
 * `PATH`, which is why this only bites the packaged app.
 */
export const TMUX_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path to a usable tmux, or `'tmux'` when none is found — leaving the
 * adapter to raise TmuxNotInstalledError, which is the caller's cue to tell the
 * user how to install it.
 *
 * `PRCLI_TMUX_BIN` overrides everything, for a non-standard install.
 */
export function resolveTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirs: readonly string[] = TMUX_FALLBACK_DIRS,
): string {
  const override = env.PRCLI_TMUX_BIN
  if (override) return override

  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean).filter(isAbsolute)
  for (const dir of [...pathDirs, ...fallbackDirs]) {
    const candidate = join(dir, 'tmux')
    if (isExecutable(candidate)) return candidate
  }

  return 'tmux'
}
