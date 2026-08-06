import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configRoot } from '../state/store'
import { type HistoryEntry, type HistoryScope } from '../../shared/ipc'

// Declared in shared/ipc.ts, not here: the renderer draws these and cannot
// import from src/main. Re-exported so this module's own callers keep
// importing them from where the rest of the shell-history code lives.
export type { HistoryEntry, HistoryScope }

export interface SelectOptions {
  scope: HistoryScope
  projectCwd: string
  filter?: string
  limit?: number
}

/** Lives under `configRoot()` so `PRCLI_CONFIG_DIR` moves it the same way it moves everything else. */
export function historyPath(): string {
  return join(configRoot(), 'history.jsonl')
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.ts === 'number' &&
    typeof record.cwd === 'string' &&
    typeof record.tab === 'string' &&
    typeof record.cmd === 'string'
  )
}

/**
 * Parse newline-delimited JSON, one `HistoryEntry` per line.
 *
 * A line that fails to parse, or parses to something that is not a
 * `HistoryEntry`, is dropped rather than failing the whole read. The file is
 * appended to by a live shell, so a partially-written last line is routine,
 * not an error.
 */
export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isEntry(parsed)) entries.push(parsed)
    } catch {
      continue
    }
  }
  return entries
}

/**
 * Whether `cwd` is the project root or somewhere beneath it.
 *
 * Compares against `${projectCwd}/`, not a bare prefix: a sibling directory
 * whose name happens to start with the project's (e.g. `PRCLI-old` next to
 * `PRCLI`) shares the prefix but is not inside it.
 */
function inProject(cwd: string, projectCwd: string): boolean {
  return cwd === projectCwd || cwd.startsWith(`${projectCwd}/`)
}

/**
 * Scope, filter, dedupe and cap a list of history entries for display.
 *
 * Requires `entries` to already be ordered oldest-to-newest, which is what
 * `parseHistory` produces: this function walks the array backward to get
 * newest-first output, it does not sort. Keeps the first (most recent)
 * occurrence of each command text, so a command run repeatedly appears
 * once, at its latest timestamp, rather than cluttering the list with
 * repeats.
 */
export function selectHistory(entries: HistoryEntry[], options: SelectOptions): HistoryEntry[] {
  const { scope, projectCwd, filter, limit = 500 } = options
  const needle = filter?.toLowerCase() ?? ''
  const seen = new Set<string>()
  const picked: HistoryEntry[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]
    if (scope === 'project' && !inProject(candidate.cwd, projectCwd)) continue
    if (needle !== '' && !candidate.cmd.toLowerCase().includes(needle)) continue
    if (seen.has(candidate.cmd)) continue
    seen.add(candidate.cmd)
    picked.push(candidate)
    if (picked.length === limit) break
  }
  return picked
}

/**
 * Read and parse the history file, bounded to its trailing `limit` lines.
 *
 * Returns an empty list for any failure to read the file, not only a
 * missing one: a permissions error or a transient I/O error should not
 * crash a caller that is just populating a history dropdown, so this
 * treats every read failure the same as "no history yet".
 *
 * `limit` bounds how many trailing lines are parsed, not how many entries
 * are returned: it exists so a very large history file doesn't have to be
 * parsed in full just to serve a recent-history request.
 */
export async function readHistory(limit = 5000): Promise<HistoryEntry[]> {
  let text: string
  try {
    text = await readFile(historyPath(), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  // Every line the hook appends ends in its own newline, so splitting on
  // '\n' leaves one trailing empty string that is not a line at all. Left
  // in, it would occupy one of the `limit` slots below and cost the read
  // its oldest real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return parseHistory(lines.slice(Math.max(0, lines.length - limit)).join('\n'))
}
