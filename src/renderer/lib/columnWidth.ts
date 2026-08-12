import { useCallback, useState } from 'react'

/**
 * How wide each side column is, in pixels, remembered per column.
 *
 * Pixels rather than the 0-1 ratios `workspace.ts` keeps for terminal panes.
 * A pane's share of a tab should follow the window when it is resized; a
 * sidebar's should not. Every column here holds text at a fixed 11px, so what
 * the user is choosing is how many characters fit, and that is a pixel count.
 *
 * Stored beside the collapse flags in localStorage, for the same reason: this
 * is a per-screen preference, not part of the workspace that `config.json`
 * restores across machines.
 */

/** The default, and what every column was fixed at before this was adjustable (`w-52`). */
export const COLUMN_WIDTH_DEFAULT = 208

/**
 * The floor, chosen so a column stays useful rather than merely visible: at
 * 11px monospace this is about 18 characters, which is a truncated file name
 * and its indent. Below that the column is a worse version of its own
 * collapsed strip, which is one click away and costs 24px.
 */
export const COLUMN_WIDTH_MIN = 140

/**
 * The ceiling's floor (measured 2026-08-12, correcting a false claim this
 * comment used to make: five columns at 560 is 2800px, which never fit in
 * the 1280px window the app opens, so "five columns" was never the failure
 * this stops). What actually bounds a single drag is `columnWidthMax` below;
 * this constant is what that function reduces to on the 1280px window, so
 * nothing about that window's behaviour changes here.
 */
export const COLUMN_WIDTH_MAX = 560

/**
 * The usable floor for the terminal itself, in pixels, below which a pane is
 * not a smaller terminal but scrollback nobody can read. `MIN_PANE_COLS` in
 * `App.tsx` already draws this same line at 20 columns, refusing a split
 * that would cross it. `Terminal.tsx`'s own measured DOM-renderer advance is
 * 7.83px per column (`releaseRenderer`'s doc, measured 2026-08-08), so 20
 * columns is about 157px; 160 rounds that up rather than down, since a floor
 * a pixel too generous costs nothing and one a pixel too tight is a promise
 * this file cannot keep.
 */
export const MIN_TERMINAL_WIDTH = 160

/**
 * The ceiling, as a function of the window's width rather than a constant.
 *
 * `COLUMN_WIDTH_MAX` was a proxy for an invariant, not the invariant itself:
 * a drag cannot leave the terminal with no usable room. A fixed proxy chosen
 * against a 1280px window is simply wrong on a 5120px one, which is the bug
 * this fixes.
 *
 * A single drag reserves `COLUMN_WIDTH_MAX` for the one other column that is
 * always on screen beside it, the projects sidebar (`Sidebar.tsx`, the only
 * column that cannot be hidden), pushed to its own ceiling too, plus
 * `MIN_TERMINAL_WIDTH` for the terminal. That is the realistic worst case a
 * single drag can create: every other column defaults to hidden, so this
 * does not model all ten of them maxed out at once, and no version of this
 * bound, before or after this change, ever has.
 *
 * On the 1280px window the app opens, `1280 - 560 - 160` is 560, which is
 * exactly where `Math.max` floors it: unchanged from before this function
 * existed. Below 1280 the same floor holds, so a squeezed window is no worse
 * either. Above it, the ceiling grows with the window, which is the point: a
 * 49" display can give a column real room without threatening the invariant.
 */
export function columnWidthMax(viewportWidth: number): number {
  return Math.max(COLUMN_WIDTH_MAX, viewportWidth - COLUMN_WIDTH_MAX - MIN_TERMINAL_WIDTH)
}

/** A width brought inside the two bounds. Non-finite input reads as the default. */
export function clampColumnWidth(px: number, viewportWidth: number): number {
  if (!Number.isFinite(px)) return COLUMN_WIDTH_DEFAULT
  return Math.min(columnWidthMax(viewportWidth), Math.max(COLUMN_WIDTH_MIN, Math.round(px)))
}

/**
 * What a stored value means. Anything unparseable is the default rather than a
 * throw: this is chrome, and a hand-edited or half-written entry should cost
 * the user their preference, not their window.
 *
 * `viewportWidth` is read by the caller rather than here, so this and
 * `clampColumnWidth` stay pure and the unit tests deterministic: a width
 * saved on a big screen and restored on a small one clamps against whatever
 * window it is actually read back into, never the one that wrote it.
 */
export function widthFromStored(
  raw: string | null,
  viewportWidth: number,
  fallback: number = COLUMN_WIDTH_DEFAULT,
): number {
  if (raw === null) return fallback
  const parsed = Number(raw)
  // `Number('')` is 0, which is finite and would clamp to the floor. An empty
  // entry is a missing one.
  if (raw.trim().length === 0 || !Number.isFinite(parsed)) return fallback
  return clampColumnWidth(parsed, viewportWidth)
}

/**
 * One column's width, restored on mount and written on commit.
 *
 * Two functions rather than one: `set` runs on every pointer move and only
 * touches React state, `commit` runs once on release and is what writes to
 * localStorage. A write per frame would be a synchronous disk-backed store
 * hit per frame, for a value nobody reads until the next launch.
 */
export function useColumnWidth(
  key: string,
  /** What this column was fixed at before it was adjustable. Notes is 256, the rest 208. */
  fallback: number = COLUMN_WIDTH_DEFAULT,
): {
  width: number
  set: (px: number) => void
  commit: () => void
} {
  const [width, setWidth] = useState(() =>
    widthFromStored(localStorage.getItem(key), window.innerWidth, fallback),
  )
  // `window.innerWidth` read fresh on every move rather than captured once:
  // the ceiling this feeds is a function of the window, and a resize mid-drag
  // should change what the drag can reach, not just what the next one can.
  const set = useCallback((px: number) => setWidth(clampColumnWidth(px, window.innerWidth)), [])
  // Reads the state through the setter rather than closing over `width`, so
  // the callback stays stable across a drag's re-renders and the resizer's
  // handler ref does not have to be rebuilt per frame.
  const commit = useCallback(() => {
    setWidth((current) => {
      localStorage.setItem(key, String(current))
      return current
    })
  }, [key])
  return { width, set, commit }
}
