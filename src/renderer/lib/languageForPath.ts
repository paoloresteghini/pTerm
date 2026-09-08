import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'

/**
 * Which grammar a path gets, or null for none.
 *
 * Split from `languageForPath` below so the decision is unit testable: vitest
 * runs with no DOM here, so a function returning a CodeMirror extension cannot
 * be asserted on, but the id it chose can.
 *
 * Unknown is null rather than a guess. A wrong grammar is worse than none: it
 * colours a file confidently and incorrectly, and this app opens whatever the
 * tree shows.
 */
export type LanguageId = 'javascript' | 'markdown' | null

export function languageIdForPath(path: string): LanguageId {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  // No dot at all (`Makefile`), or a leading dot that is the only one, where
  // what follows it is the whole name rather than an extension: `.env` is a
  // file called `env` and `.ts` is one called `ts`.
  //
  // `.ts` is the only input that covers this line, and the unit file asserts
  // it for that reason. Measured 2026-08-05 by deleting the guard: `.env`,
  // `.eslintrc.js` and every other case in that file answer identically
  // without it, so before that assertion existed this line could be removed
  // with the suite staying green.
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) return 'javascript'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  return null
}

/**
 * The CodeMirror extension for a path, or none.
 *
 * `jsx: true, typescript: true` for the whole javascript family: one
 * configuration for six extensions is one thing to get right, and the parser
 * accepts plain JS under both flags.
 */
export function languageForPath(path: string): Extension[] {
  switch (languageIdForPath(path)) {
    case 'javascript':
      return [javascript({ jsx: true, typescript: true })]
    case 'markdown':
      return [markdown()]
    default:
      return []
  }
}

/**
 * Whether a path is markdown, for the pane that decides between the rendered
 * view and the source editor.
 *
 * Derived from `languageIdForPath` rather than carrying an extension list of
 * its own, and that is the whole design of this function. The two answers must
 * never disagree: one picks the grammar the source is coloured with, the other
 * decides whether the source is what gets shown, and a file that highlights as
 * markdown but has no preview toggle (or the reverse) has no explanation a
 * user could accept. `tests/unit/languageForPath.test.ts` compares the two
 * across a mixed fixture so a second list cannot quietly appear here.
 */
export function isMarkdownPath(path: string): boolean {
  return languageIdForPath(path) === 'markdown'
}
