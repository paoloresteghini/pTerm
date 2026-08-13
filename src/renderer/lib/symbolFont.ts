/**
 * The bundled symbol face, and the one thing that has to happen before a
 * terminal can draw with it.
 *
 * `index.css` declares `@font-face { font-family: 'pTerm Symbols' }`. A
 * declaration is not a load. Measured in Chromium with the face declared in
 * CSS and referenced by nothing in the DOM: on the turn the page finished
 * parsing, `document.fonts.status` was `loading` and a canvas measured U+23F5
 * at 0.835 of a cell, the unfixed width; three seconds later it was `loaded`
 * and 0.997.
 *
 * Naming the family in a stack is not a load either, so the DOM surfaces that
 * now name it do not make this module redundant: Chromium fetches a face only
 * when a character actually resolves to it. Measured in Electron 43, a page
 * whose body used the stack but rendered only ASCII still read
 * `document.fonts.check("11px 'pTerm Symbols'")` false 1.5s in.
 *
 * A pane built inside that window keeps the wrong glyph, and that was measured
 * too, against real xterm 6.0.0 and the real WebGL addon: a terminal built and
 * drawn before the face arrived rendered byte-for-byte identically after the
 * face finished loading: the same PNG, same hash, because xterm fills its
 * glyph cache at construction and the WebGL renderer keeps a texture atlas of
 * its own. Clearing that atlas and refreshing is what made the rendering
 * change.
 *
 * So panes do not wait for this. They mount immediately and repair the atlas
 * when it resolves: see the mount effect in `Terminal.tsx`. That keeps the
 * cost off first paint, which matters because the app restores a window full
 * of terminals at launch.
 */

/**
 * The family `index.css` declares. Every monospace stack in the app names it,
 * via `--font-mono` or spelled out inline; `Terminal.tsx` is the only one that
 * also has to wait for it, because DOM text repaints itself when a face
 * arrives and an xterm atlas does not.
 */
export const SYMBOL_FAMILY = 'pTerm Symbols'

/**
 * The glyphs asked for by name rather than letting `load()` default to a
 * space. The subset has no space in it, and this way nothing rests on how an
 * engine resolves a request for a character the face does not contain.
 * Measured equivalent in Chromium 1.62 (both forms return one face and both
 * end at 0.997), so this is the form that needs no such assumption, not a fix
 * for an observed failure.
 */
const PROBE = '⏵⠇'

let pending: Promise<void> | null = null

/**
 * Resolves once the symbol face is usable, or once it is known not to be.
 *
 * Never rejects: a missing or corrupt font file must leave the terminal
 * exactly as it would have been without this module, drawing the fallback
 * glyph, rather than putting an unhandled rejection in front of a user whose
 * panes are otherwise fine. Callers get told nothing about which happened
 * because there is nothing useful for them to do differently.
 *
 * Memoised, so twelve panes mounting at once share one load.
 */
export function symbolFontReady(): Promise<void> {
  pending ??= document.fonts
    .load(`13px '${SYMBOL_FAMILY}'`, PROBE)
    .then(
      () => undefined,
      () => undefined
    )
  return pending
}
