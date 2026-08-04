/**
 * The backgrounds a pane can be set to.
 *
 * A closed set rather than a free colour, and shared between processes for the
 * same reason `SEVERITY` is: the renderer offers these, main validates against
 * these, and a second copy of the list is a copy that can disagree about what
 * a config file is allowed to contain.
 *
 * All neutral and all dark, which is not a style preference but the constraint
 * the terminal imposes. xterm's foreground is fixed at `#d4d4d8`
 * (`Terminal.tsx`, repeating `--color-term-fg`), and nothing here offers to
 * change it, so a background is only offerable if that grey stays legible on
 * it. The lightest below is `#38383d`, which leaves 7.89:1, above the 7:1 that
 * WCAG calls AAA for body text, and is the reason the ramp stops there rather
 * than continuing to a mid grey. That figure is computed rather than eyeballed
 * (`tests/unit/paneColors.test.ts` recomputes it, and caught this line saying
 * 7.6 when it was written by guess).
 *
 * The first entry is the app's own `--color-bg`. It is in the list so the
 * picker has something to mean "put it back", but choosing it stores no colour
 * at all. See `PANE_COLOR_DEFAULT`.
 */
export const PANE_COLORS = ['#09090b', '#121214', '#1a1a1d', '#232326', '#2c2c30', '#38383d'] as const

export type PaneColor = (typeof PANE_COLORS)[number]

/**
 * What a pane with no colour of its own is drawn in: `--color-bg`, the same
 * value `index.css` gives every other surface and the same one xterm is
 * constructed with.
 *
 * Absent and `'#09090b'` mean the same thing on screen, and only the absent
 * form is written. That is the rule `title` already follows (an empty name is
 * stored as missing rather than as `""`), and it exists for the same reason:
 * one representation on disk, so nothing downstream has to decide which of two
 * spellings of "default" it is looking at.
 */
export const PANE_COLOR_DEFAULT: PaneColor = PANE_COLORS[0]

/**
 * Whether a value is one of the offered colours.
 *
 * Used on the way IN, in `store.ts`, not only at the picker: a config file is
 * a text file, and the renderer is not the only thing that can put a string in
 * this field. Without this a hand-edited `"color": "#ffffff"` would reach
 * xterm's theme and leave a pane that cannot be read.
 */
export function isPaneColor(value: unknown): value is PaneColor {
  return typeof value === 'string' && (PANE_COLORS as readonly string[]).includes(value)
}
