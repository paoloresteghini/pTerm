/**
 * Every colour the app draws, five ways.
 *
 * In TypeScript rather than five `:root[data-theme]` blocks in `index.css` for
 * a reason the stylesheet already states: xterm renders to a canvas and cannot
 * read CSS variables, so `Terminal.tsx` has to be handed the values in JS.
 * With the palettes in CSS that hand-copy would have become one per theme.
 * Here the stylesheet and the terminal read the same object.
 *
 * `index.css` still declares each token in its `@theme` block, because Tailwind
 * needs that block to emit `bg-surface` and friends at build time. Those
 * declarations carry Classic's values and are overridden at runtime by
 * `applyTheme`. `tests/unit/themeCss.test.ts` holds the two in step; that test
 * is the only thing guarding the one duplication this design accepts.
 *
 * Shared rather than renderer-only because main validates the stored id
 * against `isThemeId` on the way in, and a second copy of the id list is a
 * copy that can disagree about what a config file may contain.
 */

export const THEME_IDS = ['classic', 'stepped', 'lifted', 'slate', 'lineled'] as const

export type ThemeId = (typeof THEME_IDS)[number]

/**
 * Which rule a theme's separation is judged by.
 *
 * `fill` stacks planes and is measured on the distance between them. `edge`
 * deliberately does not stack, separating by border weight and an inset lip,
 * and is measured on its border instead. `baseline` is Classic, which does
 * neither and is asserted flat on purpose.
 *
 * Required, so that adding a theme forces the question rather than letting it
 * inherit whichever rule happens to run first.
 */
export type Separation = 'fill' | 'edge' | 'baseline'

export interface ThemeTokens {
  /** The canvas: the terminal, and the ground the whole window sits on. */
  bg: string
  /** Chrome: side columns, tab bar, title bar, status bar. */
  surface: string
  /** Selected rows, inputs, wells inside a panel or a dialog. */
  raised: string
  /** Anything that floats: modals, the command palette, context menus. */
  overlay: string
  border: string
  /** The edge of a floating thing, where the ordinary border is too quiet. */
  borderStrong: string
  fg: string
  muted: string
  faint: string
  label: string
  accent: string
  /** The tab bar's split-group strip. Blended, never picked. */
  group: string
  danger: string
  /** The medium-priority mark in the Todos column. Takes one value in all five themes. */
  warn: string
  ok: string
  /** xterm's foreground. Read in JS because a canvas cannot read CSS. */
  termFg: string
  /**
   * The 1px lip along the top of a raised surface, as an 8-digit hex so that
   * "no lip" is a colour rather than a special case. Only the edge-separating
   * theme sets a visible one.
   */
  inset: string
}

export interface Theme {
  id: ThemeId
  /** What the picker calls it. */
  name: string
  separates: Separation
  tokens: ThemeTokens
}

/**
 * The custom property a token key is written to.
 *
 * One function rather than a second table: `borderStrong` becoming
 * `--color-border-strong` is a rule, and a table of sixteen pairs is sixteen
 * chances to spell one of them differently from `index.css`.
 */
export function cssVarName(key: keyof ThemeTokens): string {
  return `--color-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

export const THEMES: Record<ThemeId, Theme> = {
  classic: {
    id: 'classic',
    name: 'Classic',
    separates: 'baseline',
    tokens: {
      bg: '#09090b',
      surface: '#0c0c0e',
      raised: '#0c0c0e',
      overlay: '#0c0c0e',
      border: '#27272a',
      borderStrong: '#27272a',
      fg: '#fafafa',
      muted: '#71717a',
      faint: '#3f3f46',
      label: '#a1a1aa',
      accent: '#a3e635',
      group: '#5e8322',
      danger: '#f87171',
      warn: '#fbbf24',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#00000000',
    },
  },
  stepped: {
    id: 'stepped',
    name: 'Stepped zinc',
    separates: 'fill',
    tokens: {
      bg: '#09090b',
      surface: '#131316',
      raised: '#1b1b1f',
      overlay: '#232328',
      border: '#2c2c31',
      borderStrong: '#43434a',
      fg: '#fafafa',
      muted: '#8a8a93',
      faint: '#4a4a52',
      label: '#b1b1ba',
      accent: '#a3e635',
      group: '#5e8322',
      danger: '#f87171',
      warn: '#fbbf24',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#00000000',
    },
  },
  lifted: {
    id: 'lifted',
    name: 'Lifted chrome',
    separates: 'fill',
    tokens: {
      bg: '#060607',
      surface: '#1a1a1e',
      raised: '#232328',
      overlay: '#2c2c33',
      border: '#33333a',
      borderStrong: '#45454e',
      fg: '#f4f4f5',
      muted: '#9a9aa4',
      faint: '#56565f',
      label: '#c4c4cc',
      accent: '#a3e635',
      group: '#5c8120',
      danger: '#f87171',
      warn: '#fbbf24',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#00000000',
    },
  },
  slate: {
    id: 'slate',
    name: 'Tinted slate',
    separates: 'fill',
    tokens: {
      bg: '#0a0b10',
      surface: '#12151f',
      raised: '#1a1e2b',
      overlay: '#232839',
      border: '#2b3141',
      borderStrong: '#3b4356',
      fg: '#e8eaf2',
      muted: '#8a94aa',
      faint: '#454e63',
      label: '#b3bccd',
      accent: '#a3e635',
      group: '#5e8324',
      danger: '#fb7185',
      warn: '#fbbf24',
      ok: '#4ade80',
      termFg: '#ccd2e0',
      inset: '#00000000',
    },
  },
  lineled: {
    id: 'lineled',
    name: 'Line-led',
    separates: 'edge',
    tokens: {
      bg: '#09090b',
      surface: '#0b0b0d',
      raised: '#101013',
      overlay: '#131316',
      border: '#3f3f46',
      borderStrong: '#57575f',
      fg: '#fafafa',
      muted: '#7d7d87',
      faint: '#4a4a52',
      label: '#a1a1aa',
      accent: '#a3e635',
      group: '#5e8322',
      danger: '#f87171',
      warn: '#fbbf24',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#ffffff0e',
    },
  },
}

/** What an absent or unrecognised stored id means. */
export const THEME_DEFAULT: ThemeId = 'classic'

/**
 * Whether a value is one of the five.
 *
 * Used on the way IN, in `store.ts`, not only at the picker: config.json is a
 * text file and the renderer is not the only thing that can put a string in
 * that field.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}
