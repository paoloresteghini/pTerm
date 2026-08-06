import { homedir } from 'node:os'
import { join } from 'node:path'
import { configRoot } from '../state/store'
import { historyPath } from './history'

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
