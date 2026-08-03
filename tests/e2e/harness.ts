import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The one place the app is launched from.
 *
 * Every one of the four overrides is REQUIRED, not optional-with-a-default.
 * Three of the four spec files went without `PRCLI_CLAUDE_SETTINGS` until
 * 2026-08-02, which meant a single added click on `hooks-install` would have
 * rewritten the developer's real ~/.claude/settings.json. A required
 * parameter is the fix; a default would restore the hole with better manners.
 *
 * `tests/unit/e2eSafety.test.ts` guards both halves of that: that this
 * function's `env` names all four vars, and that no spec reaches around it to
 * `electron.launch` on its own.
 */
export async function launchApp(opts: {
  socket: string
  configDir: string
  projectsRoot: string
  claudeSettings: string
  userDataDir: string
}): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${opts.userDataDir}`],
    env: {
      ...process.env,
      // Keep the app's config out of the real ~/.prcli during tests.
      PRCLI_CONFIG_DIR: opts.configDir,
      PRCLI_TMUX_SOCKET: opts.socket,
      // The default root is the developer's real ~/Code. Even the specs that
      // never open the add-project dialog set it: defending a directory that
      // must not be scanned costs one line.
      PRCLI_PROJECTS_ROOT: opts.projectsRoot,
      // Read by every live Claude session on this machine, and the one of the
      // four a spec could omit and still pass every assertion it has.
      PRCLI_CLAUDE_SETTINGS: opts.claudeSettings,
    },
  })
}

/**
 * Destroy one test server. `-L` is not optional and never has been: a bare
 * `kill-server` would take every session the user has open with it.
 */
export async function killServer(socket: string): Promise<void> {
  await run('tmux', ['-L', socket, 'kill-server']).catch(() => undefined)
}

/**
 * Every session on one test socket, or `[]` when no server is running there.
 *
 * The empty array is for "no server yet", which is the normal state before the
 * first launch — not a way of turning a tmux failure into a pass. A caller
 * asserting a session exists still fails, because `[]` does not contain it.
 */
export async function sessionNames(socket: string): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}
