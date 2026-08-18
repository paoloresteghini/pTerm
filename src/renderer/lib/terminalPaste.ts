/**
 * What a paste into a terminal pane is carrying, when the answer changes what
 * the pane should do with it.
 *
 * Pure and framework-free like `terminalPaths.ts`, and for the same reason:
 * this repo's vitest runs `environment: 'node'`, so a rule living inside the
 * paste handler could not be unit-tested at all.
 */

/**
 * Whether a paste is an image and nothing else.
 *
 * The case this exists for: ⌘V with a screenshot on the clipboard. Chromium's
 * paste (this app ships `{ role: 'editMenu' }`, so ⌘V is Chromium's, not
 * xterm's) hands over the TEXT flavour, and an image has none, so xterm pastes
 * the empty string and the keystroke does nothing at all. A terminal's answer
 * to that keystroke is `Ctrl+V`, which programs that want images read for
 * themselves: measured 2026-08-18, Claude Code answers `0x16` by reading the
 * macOS clipboard through `osascript ... «class PNGf»` and inserting
 * `[Image #1]`, and `Ctrl+V` typed by hand already reaches a pTerm pane's pty
 * as `0x16`. So the pane translates the one gesture Chromium swallows into the
 * one the program is waiting for.
 *
 * Image AND text is deliberately NOT this case: a copy that carries both (a
 * rich-text selection, a spreadsheet cell) has a text flavour the user is far
 * likelier to have meant, and xterm's own paste already handles it correctly,
 * bracketed-paste markers and all. Only the clipboard xterm can do nothing
 * with is taken.
 *
 * `types` is the paste's ITEM types rather than `DataTransfer.types`: a
 * clipboard image arrives as an item whose type is the image's own mime
 * (`image/png`), where `DataTransfer.types` reports the opaque `'Files'` and
 * says nothing about what kind of file it is.
 */
export function imageOnlyPaste(text: string, types: readonly string[]): boolean {
  if (text !== '') return false
  return types.some((type) => type.startsWith('image/'))
}
