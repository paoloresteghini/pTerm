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
 * **The bar is split, and the split is the interesting part.** Eight of the
 * nine clear **7.89:1** against every entry in `PANE_COLORS`, which is the
 * figure this app already holds `#d4d4d8` to (`paneColors.test.ts`), so they
 * meet the house standard rather than sitting under it. `comment` alone is
 * held to **4.5:1**, WCAG AA, and that exception is named in the test so it
 * cannot quietly spread to a second role.
 *
 * The bar is a choice. The reason for the exception is a measurement, and it
 * replaced a wrong one. This file used to say 4.5 was chosen for all nine
 * because a higher bar would flatten distinct hues into one pale wash.
 * Computing it says otherwise: lifting each colour at its own hue and
 * saturation until it clears 7.89 leaves `value` untouched at `#fcd34d` and
 * moves `type` and `string` by a step or two. Seven of the nine were nowhere
 * near being the problem.
 *
 * The problem is `comment`, and only `comment`. Lifted to 7.89 it lands on
 * `#d5d5d9`, which is 1.01:1 against the `#d4d4d8` ordinary text is drawn in.
 * The colour whose entire job is to read quieter than the code becomes the
 * same colour as the code. "Dim" and "7.89:1 on the lightest pane a user can
 * pick" are contradictory requirements, so one of them gives, and it is not
 * legibility: at `#a1a1aa` it is 4.55:1 on that pane and still 1.73:1 away
 * from plain text. `tests/unit/syntaxColors.test.ts` asserts both halves.
 *
 * **What the lift cost, measured rather than waved at.** Raising the eight
 * compresses the palette: the closest pair by CIE76 distance in Lab, `string`
 * and `type`, goes from 14.0 to 11.8, and `special` and `invalid` from 23.8 to
 * 14.5. That is real compression and it is the honest residue of the argument
 * this file used to make badly. It is also still far above the roughly 2.3
 * that is one just-noticeable difference, and it was confirmed by eye in a
 * running window rather than left as arithmetic.
 */
export const SYNTAX_COLORS = {
  /** Language keywords: `const`, `class`, `return`. */
  keyword: '#d9d0fe',
  /** Strings, and the inserted side of a diff. */
  string: '#7deabf',
  /** Numbers, booleans, `null`, and anything else that is a bare value. */
  value: '#fcd34d',
  /** Names being bound or read: variables and properties. */
  name: '#9edefd',
  /** Types, classes and namespaces. */
  type: '#62ebd5',
  /** Regexes and escape sequences, which are strings that are not quite. */
  escape: '#fecd9a',
  /** `this`, `super`, macro names: names the language itself owns. */
  special: '#fbc7e3',
  /**
   * Comments and metadata, and the one entry held to 4.5 rather than 7.89.
   *
   * 4.55:1 on `#38383d`, and 1.73:1 against the `#d4d4d8` of ordinary text,
   * which is the number that earns the exception: a comment has to read
   * quieter than the code beside it, and at 7.89 it cannot. See the head of
   * this file.
   */
  comment: '#a1a1aa',
  /** Parse errors. Rare, and meant to be alarming when it is not. */
  invalid: '#fdc9c9',
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
