import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'
import { historyPath } from './history'
import { type ShellHistoryState } from '../../shared/ipc'

// Declared in shared/ipc.ts, not here, for the same reason history.ts
// re-exports HistoryEntry and HistoryScope from there: Settings (Task 5)
// draws this shape and cannot import from src/main.
export type { ShellHistoryState }

/**
 * The three paths Task 3's install/uninstall step needs: where the marker
 * block goes in the user's real `~/.zshrc`, where the generated snippet
 * itself is written, and the history file the snippet appends to.
 */
export function shellPaths(): { rcPath: string; scriptPath: string; historyFile: string } {
  return {
    // PRCLI_ZSHRC is a test seam for the same reason PRCLI_CONFIG_DIR is
    // one: without it, running the install/uninstall tests would edit the
    // developer's actual shell config.
    rcPath: process.env.PRCLI_ZSHRC ?? join(homedir(), '.zshrc'),
    // Under configRoot()'s bin/ directory, next to the Claude hook script
    // hookPaths() writes there.
    scriptPath: join(configRoot(), 'bin', 'prcli-history.zsh'),
    historyFile: historyPath(),
  }
}

/**
 * The zsh snippet that records each command a `shell` pane runs.
 *
 * Runs on every `preexec`, the hook zsh fires just before executing a typed
 * command, with the raw command line as its argument. `PRCLI_TAB_ID` gates
 * it: a shell started outside a PRCLI pane has nothing to tag the entry
 * with, so it writes nothing rather than appending an entry an overlay can
 * never scope back to a tab.
 *
 * The command text is escaped by hand rather than handed to `jq` or another
 * external tool: backslashes first, then quotes, so a literal backslash in
 * the command doesn't get counted twice once the quote-escaping adds more
 * of them. Newlines and tabs are flattened to spaces because a raw newline
 * inside the JSON string would split the record across lines, and this
 * format is one entry per line. `$PWD` is written unescaped: a directory
 * whose name contains a double quote is not something this app has to
 * support, and this is the one field here that isn't user-typed input.
 */
export function renderHistoryScript(historyFile: string): string {
  return [
    '# Written by PRCLI. Edits are overwritten on reinstall.',
    'typeset -g PRCLI_HISTORY_FILE=' + JSON.stringify(historyFile),
    '',
    'prcli_history_preexec() {',
    '  [ -n "$PRCLI_TAB_ID" ] || return 0',
    '  local cmd=$1',
    '  cmd=${cmd//\\\\/\\\\\\\\}',
    '  cmd=${cmd//\\"/\\\\\\"}',
    "  cmd=${cmd//$'\\n'/ }",
    '  cmd=${cmd//$\'\\t\'/ }',
    '  printf \'{"ts":%d,"cwd":"%s","tab":"%s","cmd":"%s"}\\n\' \\',
    '    "$EPOCHSECONDS" "$PWD" "$PRCLI_TAB_ID" "$cmd" >> "$PRCLI_HISTORY_FILE"',
    '}',
    '',
    'zmodload -F zsh/datetime +p:EPOCHSECONDS 2>/dev/null',
    'autoload -Uz add-zsh-hook',
    'add-zsh-hook preexec prcli_history_preexec',
    '',
  ].join('\n')
}

export const MARKER_START = '# >>> prcli shell history >>>'
export const MARKER_END = '# <<< prcli shell history <<<'

/** The block `merge` appends to `~/.zshrc`, bounded by markers so `unmerge` can find and remove exactly this and nothing else. */
export function block(scriptPath: string): string {
  return [MARKER_START, `[ -f ${JSON.stringify(scriptPath)} ] && source ${JSON.stringify(scriptPath)}`, MARKER_END, ''].join('\n')
}

export function isInstalled(rc: string): boolean {
  return rc.includes(MARKER_START)
}

/**
 * Append the block to `rc`, or return `rc` unchanged if it is already there.
 *
 * A blank line always separates whatever was already in `rc` from the block,
 * even when `rc` already ends in its own newline. That extra newline is what
 * lets `unmerge` invert this exactly: a merged file always has the block
 * preceded by (real content, then one blank line), and stripping one
 * trailing newline off "real content" always undoes exactly what this added,
 * with nothing left over to guess about. Without it, a single newline right
 * before the block reads the same whether `rc` supplied it or `merge` did,
 * and there is no way for `unmerge` to tell those two cases apart from the
 * text alone.
 */
export function merge(rc: string, scriptPath: string): string {
  if (isInstalled(rc)) return rc
  const separator = rc === '' ? '' : '\n'
  return `${rc}${separator}${block(scriptPath)}`
}

/**
 * Remove exactly the block `merge` would add, restoring `rc` to what it was
 * before, byte for byte.
 *
 * The one trailing newline stripped off the text before the block is the
 * separator `merge` always inserts (see `merge`'s comment): never part of
 * the caller's own content, because `merge` always adds it regardless of how
 * `rc` already ended. The leading newline stripped off the text after the
 * block is `block`'s own trailing blank line, not a separator at all.
 */
export function unmerge(rc: string): string {
  const start = rc.indexOf(MARKER_START)
  if (start === -1) return rc
  const end = rc.indexOf(MARKER_END, start)
  if (end === -1) return rc
  let before = rc.slice(0, start)
  if (before.endsWith('\n')) before = before.slice(0, -1)
  const after = end + MARKER_END.length
  return before + rc.slice(after).replace(/^\n/, '')
}

/**
 * Read `rcPath`, or `''` when there is none.
 *
 * Only ENOENT counts as "no file". Anything else (permissions, a full disk,
 * a path that is a directory) is rethrown rather than treated the same way:
 * `merge`/`unmerge` build their write from this read, so mistaking "I could
 * not read the real file" for "there is no file yet" would overwrite an
 * existing, unreadable `~/.zshrc` with just the new block, discarding
 * whatever it actually held. Mirrors `hooks/install.ts`'s `readSettings` for
 * the same reason.
 */
async function readRc(rcPath: string): Promise<string> {
  try {
    return await readFile(rcPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function readShellHistoryState(): Promise<ShellHistoryState> {
  const { rcPath, scriptPath } = shellPaths()
  return {
    installed: isInstalled(await readRc(rcPath)),
    rcPath,
    scriptPath,
    pending: block(scriptPath),
  }
}

/** Writes the snippet and appends the marker block to `~/.zshrc`. Safe to call repeatedly: `merge` is idempotent, and the script is rewritten every time so an upgrade cannot leave an older copy behind. */
export async function installShellHistory(): Promise<ShellHistoryState> {
  const { rcPath, scriptPath, historyFile } = shellPaths()
  await mkdir(dirname(scriptPath), { recursive: true })
  await writeFile(scriptPath, renderHistoryScript(historyFile), 'utf8')
  await writeFile(rcPath, merge(await readRc(rcPath), scriptPath), 'utf8')
  return readShellHistoryState()
}

/** Removes the marker block from `~/.zshrc`. The script itself is left on disk, same as `uninstallHooks` leaves its script: it does nothing once nothing sources it, and leaving it means a reinstall needs no rewrite. */
export async function uninstallShellHistory(): Promise<ShellHistoryState> {
  const { rcPath } = shellPaths()
  await writeFile(rcPath, unmerge(await readRc(rcPath)), 'utf8')
  return readShellHistoryState()
}
