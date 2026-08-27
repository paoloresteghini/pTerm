import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * Whether `'pTerm Symbols'` is still named, and still last, in every
 * monospace stack outside the terminal.
 *
 * `f874506` bundled an 8KB font subset covering the characters no macOS
 * monospace font has (the media-control block U+23F4-U+23FA and the braille
 * block U+2800-U+28FF) and added it to the terminal's own stack. `6f202ff`
 * carried it to every other monospace surface: the `--font-mono` Tailwind
 * token in `index.css` (which the `font-mono` class resolves through, across
 * many components) and the editor surfaces that set `fontFamily` directly
 * because CodeMirror does not read Tailwind tokens. That second commit
 * shipped with no test: deleting the family from any of the five lines below
 * left the whole suite green.
 *
 * Position is asserted, not just presence. The family has to come after the
 * real monospace faces (`Menlo`) so it only ever answers for a character
 * those faces lack, and before the generic `monospace` fallback so it is
 * still tried ahead of an arbitrary system default. Putting it first would
 * let it supply ordinary letters too and shift the metrics of every glyph on
 * the page, which is the reason `f874506` placed it last to begin with.
 *
 * The terminal's own stack (`Terminal.tsx`) is deliberately not in this list.
 * It already has a stronger test: `tests/e2e/terminalFont.spec.ts` measures
 * real glyph advances in a running pane, which is a better guard for the file
 * that motivated bundling the font in the first place. Reading its source
 * here would only duplicate that coverage with a weaker check.
 */

const FAMILY = 'pTerm Symbols'

/** Splits a comma-separated font stack into bare, unquoted family names. */
function families(stack: string): string[] {
  return stack.split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

/** Pulls the value out of a `label: "…"` or `label: value;` declaration. */
function declarationValue(source: string, pattern: RegExp, describeWhat: string): string {
  const found = pattern.exec(source)
  if (!found) throw new Error(`could not find ${describeWhat}`)
  return found[1]
}

const STACKS: { path: string; find: (source: string) => string }[] = [
  {
    path: '../../src/renderer/index.css',
    find: (source) => declarationValue(source, /--font-mono:\s*([^;]+);/, '--font-mono in index.css'),
  },
  {
    path: '../../src/renderer/TodoModal.tsx',
    find: (source) => declarationValue(source, /fontFamily:\s*"([^"]+)"/, 'fontFamily in TodoModal.tsx'),
  },
  {
    path: '../../src/renderer/IssueModal.tsx',
    find: (source) => declarationValue(source, /fontFamily:\s*"([^"]+)"/, 'fontFamily in IssueModal.tsx'),
  },
  {
    path: '../../src/renderer/ui/MarkdownView.tsx',
    find: (source) => declarationValue(source, /fontFamily:\s*"([^"]+)"/, 'fontFamily in MarkdownView.tsx'),
  },
]

describe('the pTerm Symbols font stack', () => {
  for (const stack of STACKS) {
    it(`names '${FAMILY}' after Menlo and before the generic fallback, in ${stack.path.replace('../../', '')}`, () => {
      const list = families(stack.find(read(stack.path)))

      const menlo = list.indexOf('Menlo')
      const symbols = list.indexOf(FAMILY)
      const generic = list.indexOf('monospace')

      expect(menlo, `Menlo missing from stack: ${list.join(', ')}`).toBeGreaterThanOrEqual(0)
      expect(symbols, `'${FAMILY}' missing from stack: ${list.join(', ')}`).toBeGreaterThanOrEqual(0)
      expect(generic, `generic 'monospace' fallback missing from stack: ${list.join(', ')}`).toBeGreaterThanOrEqual(0)

      expect(symbols, `'${FAMILY}' must come after Menlo: ${list.join(', ')}`).toBeGreaterThan(menlo)
      expect(symbols, `'${FAMILY}' must come before the generic fallback: ${list.join(', ')}`).toBeLessThan(generic)
    })
  }
})
