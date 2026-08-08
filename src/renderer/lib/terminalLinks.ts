/**
 * Finding links in a pane's text, and deciding whether a click follows one.
 *
 * Pure on purpose. `shell.openExternal` cannot be intercepted from an e2e
 * spec (Electron exposes `shell`'s members as non-writable, so the patch a
 * test would need either throws or silently no-ops), so nothing downstream of
 * a click is observable from the suite. Keeping the two decisions here — what
 * counts as a link, and which click follows it — puts the part that can be
 * wrong under `tests/unit/terminalLinks.test.ts`, and leaves `Terminal.tsx`
 * holding only wiring.
 *
 * Written against xterm 6's core `registerLinkProvider` rather than
 * `@xterm/addon-web-links`: that addon's stable line (0.12.0) predates xterm
 * 6, and the only versions built for it are betas.
 */

/** A url found on one line, as half-open offsets into that line. */
export interface FoundLink {
  url: string
  /** Index of the first character, 0-based. */
  start: number
  /** Index one past the last character. */
  end: number
}

/*
 * http(s) only, and the scheme must start at a word boundary so
 * `nothttp://x` is not a link. The body runs to whitespace or a control
 * character. The class is written with escapes on purpose: the raw control
 * bytes it replaced rendered as an innocent-looking ` -` in an editor, and
 * were misread as excluding hyphens (measured 2026-08-07). Everything finer
 * than that is trimming, below, because a URL's
 * own grammar allows almost every punctuation mark that also ends an English
 * sentence.
 */
const CANDIDATE = /\bhttps?:\/\/[^\s\x00-\x1f\x7f]+/g

/** Marks that end a sentence rather than an address. */
const TRAILING = /[.,;:!?'"]+$/

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '>': '<' }

/**
 * Trim what the address cannot own.
 *
 * A closing bracket is kept only when the url opened it, which is what
 * separates `…/A_(disambiguation)` from a url someone wrapped in parentheses.
 * Looped because the two rules feed each other: `(https://x.com/a).` has to
 * lose the dot before the paren is on the end to be judged at all.
 */
function trim(url: string): string {
  let out = url
  for (;;) {
    const before = out
    out = out.replace(TRAILING, '')
    const last = out.at(-1)
    const opener = last ? CLOSERS[last] : undefined
    if (opener !== undefined) {
      const opens = out.split(opener).length - 1
      const closes = out.split(last as string).length - 1
      if (closes > opens) out = out.slice(0, -1)
    }
    if (out === before) return out
  }
}

/**
 * Every http(s) url on one line of pane text, in order.
 *
 * Offsets are into the string handed in, so a caller building an xterm range
 * converts with `x: start + 1` for the start (x is 1-based) and `x: end` for
 * the end (1-based and inclusive, which is the same number as a 0-based
 * exclusive end).
 */
export function findLinks(line: string): FoundLink[] {
  const found: FoundLink[] = []
  for (const match of line.matchAll(CANDIDATE)) {
    const raw = match[0]
    const url = trim(raw)
    // Trimming can empty a match only if it were all punctuation, which the
    // scheme prefix rules out; guarded anyway so a zero-width range, which
    // xterm would still decorate, cannot be produced.
    if (url.length === 0) continue
    const start = match.index
    found.push({ url, start, end: start + url.length })
  }
  return found
}

/** The modifier state of a click, as much of it as this decision needs. */
export interface ClickModifiers {
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/**
 * Whether a click on a link should open it.
 *
 * ⌘ and nothing else, which is what Terminal.app, iTerm2 and VS Code all use.
 * A bare click stays with the pane, where it starts a selection and may be
 * read by a program behind the pty; the other combinations are left alone
 * for the same reason, rather than treated as near-misses for ⌘.
 */
export function followsLink(modifiers: ClickModifiers): boolean {
  return modifiers.metaKey && !modifiers.altKey && !modifiers.ctrlKey && !modifiers.shiftKey
}

/**
 * The xterm buffer range for a link found on `bufferLineNumber`.
 *
 * Split out from the provider so the off-by-one is under test rather than
 * inline: xterm's x is 1-BASED and INCLUSIVE at both ends, while `findLinks`
 * reports half-open 0-based offsets. So the start gains one and the end does
 * not, which is easy to get wrong in a way that shifts every underline by a
 * character and still looks plausible on screen.
 */
export function linkRange(
  link: Pick<FoundLink, 'start' | 'end'>,
  bufferLineNumber: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  return {
    start: { x: link.start + 1, y: bufferLineNumber },
    end: { x: link.end, y: bufferLineNumber },
  }
}
