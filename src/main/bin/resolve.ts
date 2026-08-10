import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Where a Homebrew-installed CLI lives when `PATH` doesn't say. An app
 * launched from Finder or the Dock inherits launchd's `PATH` —
 * `/usr/bin:/bin:/usr/sbin:/sbin` — not the one from your shell profile, so
 * anything under `/opt/homebrew/bin` or `/usr/local/bin` is invisible to it.
 * Every test and every `npm start` runs from a shell that already has
 * Homebrew on `PATH`, which is why this only bites the packaged app.
 */
export const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path to a usable `name`, or `name` itself when none is found —
 * leaving the caller to spawn it and report the ENOENT in whatever terms its
 * user understands.
 *
 * `PATH` wins over the fallbacks so a deliberately-chosen install is still
 * the one that runs; the fallbacks only cover the directories launchd left out.
 */
export function resolveBin(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirs: readonly string[] = FALLBACK_DIRS,
): string {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean).filter(isAbsolute)
  for (const dir of [...pathDirs, ...fallbackDirs]) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return name
}
