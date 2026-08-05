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
  // No dot at all (`Makefile`), or a leading dot that is the only one
  // (`.env`), where what follows it is the whole name rather than an
  // extension. A dotfile with a second dot still has one: `.eslintrc.js` is
  // javascript, and the unit file asserts that so this guard is not read as
  // rejecting every dotfile.
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
