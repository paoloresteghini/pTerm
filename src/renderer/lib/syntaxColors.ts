import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * The colours syntax highlighting is allowed to use, by role.
 *
 * A closed set with a measured floor, for the same reason `PANE_COLORS` is
 * one: nothing downstream checks whether a syntax colour can be read, so the
 * list itself is the only place that rule can live.
 *
 * **Why this exists at all.** CodeMirror ships `defaultHighlightStyle`, and it
 * is a LIGHT-background palette. Measured 2026-08-05 in a running window:
 * keywords came out `rgb(119, 0, 136)`, definitions `rgb(0, 0, 255)`,
 * literals `rgb(17, 102, 68)`. Across all fourteen of its coloured entries the
 * best was 5.17:1 on `#09090b` and 3.03:1 on `#38383d`, and the worst two were
 * 1.04:1 on `#38383d`, which is a colour the user can pick from the pane's own
 * right-click menu. The same characters uncoloured are 13.46:1 and 7.89:1, so
 * turning highlighting on made every single token harder to read than leaving
 * it off. `editor-missing` four files away records this repo refusing a colour
 * at 1.9:1 on exactly those grounds.
 *
 * **The bar is 4.5:1 against every entry in `PANE_COLORS`**, WCAG AA for
 * normal text, worst case the lightest pane `#38383d`. That is a stated
 * choice and not a measurement: plain text's 7.89:1 was considered and
 * rejected as the bar here, because forcing nine distinct hues that high on a
 * near-black background drives them towards a set of near-white pastels that
 * are hard to tell apart, and a palette whose colours are individually legible
 * but mutually indistinguishable does not highlight anything.
 * `tests/unit/syntaxColors.test.ts` computes every colour against every pane
 * and is what fails when one is added below the bar.
 *
 * Hues are chosen to stay separable from each other as well as from the
 * background, which contrast arithmetic alone does not give you: keyword,
 * string, comment, value and name each read as a different thing.
 */
export const SYNTAX_COLORS = {
  /** Language keywords: `const`, `class`, `return`. */
  keyword: '#c4b5fd',
  /** Strings, and the inserted side of a diff. */
  string: '#6ee7b7',
  /** Numbers, booleans, `null`, and anything else that is a bare value. */
  value: '#fcd34d',
  /** Names being bound or read: variables and properties. */
  name: '#7dd3fc',
  /** Types, classes and namespaces. */
  type: '#5eead4',
  /** Regexes and escape sequences, which are strings that are not quite. */
  escape: '#fdba74',
  /** `this`, `super`, macro names: names the language itself owns. */
  special: '#f9a8d4',
  /**
   * Comments and metadata. The dimmest entry, which is the point, and the one
   * with the least headroom over the bar at 4.55:1 on `#38383d`. A comment
   * that reads as loudly as the code is a comment in the way.
   */
  comment: '#a1a1aa',
  /** Parse errors. Rare, and meant to be alarming when it is not. */
  invalid: '#fca5a5',
} as const

/**
 * `defaultHighlightStyle`'s tag coverage, in colours that can be read here.
 *
 * Every tag that style colours is colour here too, so nothing that was
 * highlighted before this change goes plain. Its five colourless entries
 * (`link`, `heading`, `emphasis`, `strong`, `strikethrough`) are carried
 * across unchanged: they carry markdown's shape rather than a hue, and a
 * contrast bar has nothing to say about an underline.
 */
export const syntaxColorStyle = HighlightStyle.define([
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.heading, textDecoration: 'underline', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },

  { tag: [tags.comment, tags.meta], color: SYNTAX_COLORS.comment },
  { tag: tags.keyword, color: SYNTAX_COLORS.keyword },
  { tag: [tags.string, tags.deleted], color: SYNTAX_COLORS.string },
  {
    tag: [tags.literal, tags.inserted, tags.atom, tags.bool, tags.url, tags.contentSeparator],
    color: SYNTAX_COLORS.value,
  },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: SYNTAX_COLORS.escape },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.local(tags.variableName),
      tags.definition(tags.propertyName),
      tags.labelName,
    ],
    color: SYNTAX_COLORS.name,
  },
  { tag: [tags.typeName, tags.namespace, tags.className], color: SYNTAX_COLORS.type },
  { tag: [tags.special(tags.variableName), tags.macroName], color: SYNTAX_COLORS.special },
  { tag: tags.invalid, color: SYNTAX_COLORS.invalid },
])
