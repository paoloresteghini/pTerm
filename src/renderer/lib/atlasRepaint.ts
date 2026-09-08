/**
 * Repairing the WebGL glyph atlas after the symbol font arrives, without
 * blanking every other pane in the process.
 *
 * xterm does not give each terminal its own texture atlas. `addon-webgl`
 * keeps a module-level cache (`CharAtlasCache`) keyed on font, size, colours
 * and cell geometry, and hands the SAME `TextureAtlas` object to every
 * terminal whose config matches, tracking them in an `ownedBy` list. In this
 * app that is every pane on the default colour: they all share one atlas.
 *
 * That makes `Terminal.clearTextureAtlas()` a cross-pane operation, and a
 * lopsided one. It wipes the shared atlas (every cached rasterisation, every
 * glyph position) and then clears the RENDER MODEL of the one terminal it was
 * called on. Every other pane keeps a model full of texture coordinates that
 * now point into cleared space, and nothing tells it. `TextureAtlas.clearTexture`
 * does not set the atlas's own `_requestClearModel` flag, which is what makes
 * this different from an atlas page merge: a merge sets that flag and every
 * sharing renderer repairs itself on its next frame, where a clear leaves
 * them stale indefinitely.
 *
 * The damage is invisible until something repaints those panes, because a
 * pane that draws nothing keeps its last good frame on screen. What finally
 * shows it is `Terminal.tsx`'s own re-fit on a tab becoming visible:
 * `term.refresh()` marks rows dirty, and `WebglRenderer._updateModel` skips
 * every cell whose code, fg, bg and ext are unchanged, so it rewrites the
 * handful of cells that really changed and leaves the rest pointing at
 * nothing. The pane comes back mostly blank with a scatter of wrong glyphs.
 * Only a full model clear repairs it, which is why nudging the window by a
 * pixel (`handleResize` clears the model) fixed it and switching tabs did not.
 *
 * **Measured 2026-09-08**, two real xterm terminals with the real WebGL addon
 * in this app's own Electron, one 70x40 pane screenshotted through
 * `webContents.capturePage` and its lit pixels counted:
 *
 * | step                                       | lit pixels |
 * |--------------------------------------------|-----------:|
 * | baseline                                   |    184,671 |
 * | sibling calls `clearTextureAtlas()`        |    184,671 |
 * | this pane calls `refresh(0, rows - 1)`     |     21,993 |
 * | this pane resizes and resizes back         |    184,671 |
 * | this pane calls `clearTextureAtlas()`      |    184,671 |
 *
 * The two terminals reported the same atlas canvas by identity, and flooding
 * the sibling with 4,000 distinct glyphs to force a page merge did NOT
 * corrupt this pane (184,671 throughout), which is what rules the merge path
 * out and leaves the app's own clear as the only trigger.
 *
 * Hence this module. The clear happens ONCE for the app rather than once per
 * pane, because the only thing it repairs is a rasterisation taken before the
 * face loaded, and a pane mounted after that has nothing to repair. And when
 * it does happen, every pane that is mounted is told, so the panes that did
 * not ask for it end up with a cleared model too.
 */

/**
 * What this needs from an xterm terminal. Narrow enough that a test can pass
 * a plain object and count the calls, which is the only way the "every pane,
 * not just the one that asked" half of this can be asserted at all: the
 * damage it prevents is pixels, and no unit test can see those.
 */
export interface AtlasPane {
  clearTextureAtlas(): void
  refresh(start: number, end: number): void
  readonly rows: number
}

/**
 * A repair that runs at most once, over whichever panes are mounted when it
 * does.
 *
 * A factory rather than a module-level flag so a test can have its own, and
 * so nothing has to export a reset that only tests would call.
 */
export function createFontAtlasRepair(): (panes: Iterable<AtlasPane>) => void {
  let repaired = false
  return (panes) => {
    if (repaired) return
    repaired = true
    for (const pane of panes) {
      // Both, in this order, per pane. The clear is a no-op on every pane
      // after the first (`clearTexture` returns early once the first page is
      // back at its origin), and that is fine: what the later calls are
      // really for is the model clear each one does for its own renderer.
      pane.clearTextureAtlas()
      pane.refresh(0, pane.rows - 1)
    }
  }
}
