/**
 * Computed colours as hex, and the perceptual distance between two of them.
 *
 * `getComputedStyle` returns `rgb(r, g, b)`, never the hex the stylesheet was
 * written in, so an assertion about a token has to convert before it can
 * compare.
 *
 * The distance is CIE L*, not WCAG contrast ratio, for the reason the whole
 * theme feature turns on: the ratio carries a +0.05 flare term that flattens
 * every near-black comparison into roughly the same number, mapping all five
 * of this app's palettes onto 1.01 to 1.17. It cannot tell them apart. It is
 * the right instrument for text on a ground and the wrong one for two dark
 * planes abutting.
 *
 * Duplicated from `tests/unit/contrast.ts` rather than imported: that module
 * is loaded by the vitest suite and this one runs under Playwright, and the
 * two configs do not share a resolver. The arithmetic is small and fixed, and
 * `tests/unit/themes.test.ts` is what holds the palettes themselves to these
 * floors. If that changes, this copy is a second place to correct.
 */

/** `rgb(9, 9, 11)` or `rgba(9, 9, 11, 1)` to `#09090b`. Throws on anything else. */
export function parseRgb(value: string): string {
  const found = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value.trim())
  if (!found) throw new Error(`not an rgb colour: ${value}`)
  return `#${found
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function lightness(hex: string): number {
  const y = luminance(hex)
  return y <= 0.008856 ? 903.2963 * y : 116 * Math.cbrt(y) - 16
}

/** Distance in CIE L*, order independent. */
export function lightnessGap(a: string, b: string): number {
  return Math.abs(lightness(a) - lightness(b))
}
