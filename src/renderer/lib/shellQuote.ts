/**
 * Turning dropped file paths into text a shell reads as one argument each.
 *
 * Pure, and separate from `Terminal.tsx`, for the same reason as
 * `lib/terminalLinks.ts`: the step that produces these paths cannot be
 * exercised from the suite. `webUtils.getPathForFile` resolves a `File` minted
 * inside a Playwright page to `''`, so no e2e can prove a real path reaches
 * the pty. Everything decided after we have the path is decided here, under
 * `tests/unit/shellQuote.test.ts`.
 */

/**
 * Characters a path may contain without any quoting.
 *
 * An allowlist rather than a list of dangerous characters: the shell acts on
 * far more punctuation than anyone reliably remembers, and the failure mode of
 * forgetting one is a path that silently becomes two arguments, or worse, a
 * glob or a command substitution. Anything not named here gets quoted, which
 * is always safe and merely noisier.
 */
const SAFE = /^[A-Za-z0-9_\-./=+:,@%]+$/

/**
 * One path, ready to sit on a command line as a single argument.
 *
 * Single quotes because they are the only shell quoting with no interior
 * escapes at all: everything between them is literal. The exception is a
 * single quote itself, which cannot appear inside them, so the string is
 * closed, an escaped quote emitted, and the string reopened — the familiar
 * `'it'\''s'`.
 *
 * An empty string quotes to `''` rather than to nothing, so a caller that
 * hands one over produces a visible empty argument instead of silently
 * shortening the command. `dropText` drops empties before they reach here.
 */
export function quoteForShell(path: string): string {
  if (path.length > 0 && SAFE.test(path)) return path
  return `'${path.split("'").join("'\\''")}'`
}

/**
 * What a drop types: every resolved path, quoted as needed, space separated.
 *
 * Never ends with a newline and never contains one unquoted. The text lands in
 * a line the user may be halfway through typing, so it must not submit it.
 *
 * Paths that could not be resolved are dropped rather than quoted. That is not
 * a hypothetical: `webUtils.getPathForFile` answers `''` for anything outside
 * a real file drag, and quoting it would type a stray `''` argument.
 */
export function dropText(paths: string[]): string {
  return paths
    .filter((path) => path.length > 0)
    .map(quoteForShell)
    .join(' ')
}
