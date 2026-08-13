/**
 * Finding file paths in a pane's text, and deciding what a click on one does.
 *
 * The sibling of `terminalLinks.ts`, and pure for the same reason: the two
 * decisions that can be wrong (what looks like a path, and what a path means)
 * belong under `tests/unit/terminalPaths.test.ts`, leaving `Terminal.tsx`
 * holding wiring. The provider that uses this is registered next to the url
 * one, against xterm 6's core `registerLinkProvider`.
 *
 * **Nothing here decides that a path EXISTS.** A candidate is a shape, not a
 * file, and the shapes below are deliberately permissive: `findPaths` will
 * happily return `e.g` from prose. What turns a candidate into an underlined
 * link is main answering that it resolves to a readable file inside the
 * project (`fsProbe`). That order matters. Offering a link that errors when
 * clicked is a defect this codebase already has elsewhere and did not want a
 * third instance of, and no regex tight enough to avoid it would still match
 * the paths people actually paste.
 */

/** A path candidate found on one line, as half-open offsets into that line. */
export interface FoundPath {
  /**
   * The path as written, with any `:line` or `:line:col` suffix removed and
   * any leading `./` kept: this is the string handed to `toRelative`, not yet
   * one main will accept.
   */
  path: string
  /** Index of the first character of `path`, 0-based. */
  start: number
  /**
   * Index one past the last character of `path`, NOT of the `:line:col`
   * suffix. The suffix is left outside the link on purpose: neither the
   * editor pane nor the system opener can scroll to a line, so underlining
   * `:589` would promise a jump that nothing performs.
   */
  end: number
}

/**
 * A run of characters that could be a path.
 *
 * Stops at whitespace, control characters, and the quotes and brackets that
 * wrap a path in prose and in shell output. A comma is NOT excluded here
 * because it is legal in a filename; it is trimmed below instead, where the
 * trailing-punctuation rule can see whether it ends the token.
 */
const CANDIDATE = /[^\s\x00-\x1f\x7f'"`()[\]{}<>|]+/g

/** Marks that end a sentence rather than a path. */
const TRAILING = /[.,;:!?]+$/

/** `:12` or `:12:34` on the end, which is a reference to a line, not a name. */
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/

/**
 * An extension: a dot, then one to eight of the characters an extension is
 * made of, at the very end. `tabs.spec.ts` qualifies on `.ts`; `1.2.3` does
 * too, which the existence probe then rejects.
 */
const EXTENSION = /\.[A-Za-z0-9_]{1,8}$/

/**
 * Every path-shaped token on one line, in order.
 *
 * A token qualifies when it has an extension or contains a separator, which
 * between them cover `src/renderer/App.tsx`, `./scripts/build`, and
 * `tabs.spec.ts` standing alone, while leaving ordinary words alone. A url is
 * excluded outright rather than left to the probe: `terminalLinks.ts` already
 * offers those, and two providers underlining the same cells is a link whose
 * behaviour depends on which one xterm asked first.
 *
 * Offsets are into the string handed in, so a caller building an xterm range
 * converts with `x: start + 1` for the start and `x: end` for the end. See
 * `linkRange` in `terminalLinks.ts`, which does exactly that and is reused.
 */
export function findPaths(line: string): FoundPath[] {
  const found: FoundPath[] = []
  for (const match of line.matchAll(CANDIDATE)) {
    const raw = match[0]
    if (raw.includes('://')) continue
    // A leading dash is an option (`--reporter=line`), never a path, and a
    // leading `=` is the tail of one that has already been split badly.
    if (raw.startsWith('-') || raw.startsWith('=')) continue

    let path = raw.replace(TRAILING, '')
    const suffix = LINE_SUFFIX.exec(path)
    if (suffix) path = path.slice(0, suffix.index)
    // Trim again: `App.tsx:2284.` loses the dot, then the suffix, and a
    // token that was only punctuation and digits is now empty.
    path = path.replace(TRAILING, '')
    if (path.length === 0) continue
    if (!EXTENSION.test(path) && !path.includes('/')) continue
    // A bare separator, or a token that is all separators, names no file.
    if (path.replaceAll('/', '').length === 0) continue

    found.push({ path, start: match.index, end: match.index + path.length })
  }
  return found
}

/**
 * The extensions the editor pane cannot show.
 *
 * A deny-list rather than an allow-list of text extensions, because the long
 * tail here is text: `.env`, `.gitignore`, `.lock`, a shell script with no
 * extension at all. Getting one of those wrong sends a readable file to
 * Preview; getting a member of this list wrong pours bytes into CodeMirror.
 * The second is the worse failure, so the list names the binaries.
 */
const OPAQUE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'heic', 'avif',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'tar', 'dmg', 'pkg',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'node', 'asar', 'class', 'jar',
  'sqlite', 'db', 'psd', 'sketch', 'fig',
])

/**
 * Whether the editor pane can show this file, decided by extension alone.
 *
 * Extension alone, and no sniffing of the bytes: the decision is made in the
 * renderer, before anything has been read, so that a click routes without a
 * round trip that would only tell it what the name already says. A file with
 * no extension is treated as text, which is right for a script and wrong for
 * a stripped binary; the wrong case is recoverable by looking at the pane and
 * closing it.
 */
export function opensInEditor(path: string): boolean {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash + 1) return true
  return !OPAQUE.has(path.slice(dot + 1).toLowerCase())
}

/**
 * `path` as something main will accept for `projectCwd`, or null.
 *
 * Only relative paths cross IPC, which is `resolveInside`'s rule and not this
 * function's to bend: it rejects an absolute `relPath` outright, and the
 * comment there says why (an IPC channel that reads a path is that primitive
 * for anything that reaches the renderer). So an absolute path printed in the
 * terminal is made relative HERE, where the project's own cwd is known, and
 * one that does not live under that cwd becomes null and is never offered as
 * a link at all.
 *
 * That is also the whole of the "project-relative only" scope. A path outside
 * the project is not refused later with a message; it never underlines.
 */
export function toRelative(path: string, projectCwd: string): string | null {
  const cwd = projectCwd.endsWith('/') ? projectCwd.slice(0, -1) : projectCwd
  if (path.startsWith('/')) {
    if (!path.startsWith(`${cwd}/`)) return null
    return path.slice(cwd.length + 1)
  }
  // `./x` and `x` are the same file; `..` leaves the project, and main would
  // refuse it, but refusing here keeps the link from being drawn.
  const cleaned = path.replace(/^(?:\.\/)+/, '')
  if (cleaned.length === 0 || cleaned === '.' || cleaned.split('/').includes('..')) return null
  return cleaned
}
