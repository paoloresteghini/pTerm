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
 * The ceiling. Five columns at this width still leave terminal on the 1280px
 * window the app opens, which is the failure this stops: a drag that can eat
 * the whole window can leave the user with no pane and no obvious way back.
 */
export const COLUMN_WIDTH_MAX = 560

/** A width brought inside the two bounds. Non-finite input reads as the default. */
export function clampColumnWidth(px: number): number {
  if (!Number.isFinite(px)) return COLUMN_WIDTH_DEFAULT
  return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(px)))
}

/**
 * What a stored value means. Anything unparseable is the default rather than a
 * throw: this is chrome, and a hand-edited or half-written entry should cost
 * the user their preference, not their window.
 */
export function widthFromStored(
  raw: string | null,
  fallback: number = COLUMN_WIDTH_DEFAULT,
): number {
  if (raw === null) return fallback
  const parsed = Number(raw)
  // `Number('')` is 0, which is finite and would clamp to the floor. An empty
  // entry is a missing one.
  if (raw.trim().length === 0 || !Number.isFinite(parsed)) return fallback
  return clampColumnWidth(parsed)
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
  const [width, setWidth] = useState(() => widthFromStored(localStorage.getItem(key), fallback))
  const set = useCallback((px: number) => setWidth(clampColumnWidth(px)), [])
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
