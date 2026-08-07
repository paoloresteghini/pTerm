import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'
import { backupIfPresent } from '../hooks/install'
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
    // PTERM_ZSHRC is a test seam for the same reason PTERM_CONFIG_DIR is
    // one: without it, running the install/uninstall tests would edit the
    // developer's actual shell config.
    rcPath: process.env.PTERM_ZSHRC ?? join(homedir(), '.zshrc'),
    // Under configRoot()'s bin/ directory, next to the Claude hook script
    // hookPaths() writes there.
    scriptPath: join(configRoot(), 'bin', 'pterm-history.zsh'),
    historyFile: historyPath(),
  }
}

/**
 * The zsh snippet that records each command a `shell` pane runs.
 *
 * Runs on every `preexec`, the hook zsh fires just before executing a typed
 * command, with the raw command line as its argument. `PTERM_TAB_ID` gates
 * it: a shell started outside a pTerm pane has nothing to tag the entry
 * with, so it writes nothing rather than appending an entry an overlay can
 * never scope back to a tab.
 *
 * A command line beginning with a space is dropped, which is what
 * `HIST_IGNORE_SPACE` does for zsh's own history file. `preexec` runs before
 * and independently of that option, so without this the one gesture people
 * use to keep a password or a token out of a log would keep it out of
 * `~/.zsh_history` and write it here instead. Done unconditionally rather than
 * behind a `setopt hist_ignore_space` test, because the cost of honouring it
 * for someone who did not ask is one missing entry and the cost of the other
 * mistake is a recorded secret. Measured 2026-08-06: `preexec`'s `$1` is the
 * line as typed, leading space and all, so this can see it.
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
    '# Written by pTerm. Edits are overwritten on reinstall.',
    'typeset -g PTERM_HISTORY_FILE=' + JSON.stringify(historyFile),
    '',
    'pterm_history_preexec() {',
    '  [ -n "$PTERM_TAB_ID" ] || return 0',
    "  [[ $1 == ' '* ]] && return 0",
    '  local cmd=$1',
    '  cmd=${cmd//\\\\/\\\\\\\\}',
    '  cmd=${cmd//\\"/\\\\\\"}',
    "  cmd=${cmd//$'\\n'/ }",
    '  cmd=${cmd//$\'\\t\'/ }',
    '  printf \'{"ts":%d,"cwd":"%s","tab":"%s","cmd":"%s"}\\n\' \\',
    '    "$EPOCHSECONDS" "$PWD" "$PTERM_TAB_ID" "$cmd" >> "$PTERM_HISTORY_FILE"',
    '}',
    '',
    'zmodload -F zsh/datetime +p:EPOCHSECONDS 2>/dev/null',
    'autoload -Uz add-zsh-hook',
    'add-zsh-hook preexec pterm_history_preexec',
    '',
  ].join('\n')
}

export const MARKER_START = '# >>> pterm shell history >>>'
export const MARKER_END = '# <<< pterm shell history <<<'

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
  const { rcPath, scriptPath, historyFile } = shellPaths()
  return {
    installed: isInstalled(await readRc(rcPath)),
    rcPath,
    scriptPath,
    historyFile,
    pending: block(scriptPath),
  }
}

/**
 * Replace `rcPath` with `next`, keeping a dated copy of what was there.
 *
 * Both of this module's writes go through here, and neither writes at all
 * when `next` already matches what is on disk. That is what keeps a reinstall
 * from leaving a `.bak` behind every time it is clicked, and it is why the
 * backups that DO exist each mark a real change to the file.
 *
 * The timestamp in the name is `backupIfPresent`'s, and the reason is the one
 * given where `installHooks` calls it: a second install months later must not
 * overwrite the copy that predates pTerm touching this file at all.
 */
async function writeRc(rcPath: string, current: string, next: string): Promise<void> {
  if (next === current) return
  await backupIfPresent(rcPath)
  await writeFile(rcPath, next, 'utf8')
}

/**
 * Create the history file, or tighten an existing one, at 0600.
 *
 * The hook appends with `>>`, and a file the shell creates that way lands at
 * `0666 & ~umask`: measured on macOS with the default `umask 022`, that is
 * 0644. Every local account on a Mac is in group `staff`, so 0644 means the
 * other accounts on the machine can read a verbatim log of every command run
 * in every pTerm shell pane. zsh does not leave its own `~/.zsh_history` that
 * way, and this file holds the same commands.
 *
 * Creating it here means the hook's first append inherits this mode rather
 * than choosing one. `flag: 'a'` makes the create a no-op when the file is
 * already there, and `mode` applies only when a file is created, so the
 * `chmod` is what fixes a file an earlier version of this app left at 0644.
 */
async function secureHistoryFile(historyFile: string): Promise<void> {
  await mkdir(dirname(historyFile), { recursive: true })
  await writeFile(historyFile, '', { flag: 'a', mode: 0o600 })
  await chmod(historyFile, 0o600)
}

/** Writes the snippet and appends the marker block to `~/.zshrc`. Safe to call repeatedly: `merge` is idempotent, and the script is rewritten every time so an upgrade cannot leave an older copy behind. */
export async function installShellHistory(): Promise<ShellHistoryState> {
  const { rcPath, scriptPath, historyFile } = shellPaths()
  const current = await readRc(rcPath)
  await mkdir(dirname(scriptPath), { recursive: true })
  await writeFile(scriptPath, renderHistoryScript(historyFile), 'utf8')
  await secureHistoryFile(historyFile)
  await writeRc(rcPath, current, merge(current, scriptPath))
  return readShellHistoryState()
}

/** Removes the marker block from `~/.zshrc`. The script itself is left on disk, same as `uninstallHooks` leaves its script: it does nothing once nothing sources it, and leaving it means a reinstall needs no rewrite. */
export async function uninstallShellHistory(): Promise<ShellHistoryState> {
  const { rcPath } = shellPaths()
  const current = await readRc(rcPath)
  await writeRc(rcPath, current, unmerge(current))
  return readShellHistoryState()
}
