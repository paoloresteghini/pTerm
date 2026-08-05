/**
 * WCAG relative luminance and contrast ratio.
 *
 * Extracted from `paneColors.test.ts`, which defined both privately and was
 * the only file that needed them until `syntaxColors.test.ts` came to make the
 * same kind of assertion about a different list. A second copy of this
 * arithmetic is a second copy that can be wrong on its own, and this pair is
 * what decided that `PANE_COLORS` stops at `#38383d`.
 *
 * A plain module rather than an export from the test file that had it: vitest
 * collects `tests/unit/**\/*.test.ts`, so importing one test file from another
 * would register its suites twice. Not in `src/` because nothing in the
 * application computes contrast; the rule is asserted about the app, not by
 * it.
 */

/** WCAG relative luminance, from the sRGB definition. Six-digit `#rrggbb`. */
export function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio between two colours, 1 to 21, order independent. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
