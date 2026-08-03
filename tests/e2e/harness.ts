import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The prefix every socket this suite is allowed to touch must carry.
 *
 * Until now this was convention, held by four `const SOCKET = 'prcli-e2e…'`
 * lines and nothing else, and both ways of breaking it are silent:
 *
 * - `TmuxAdapter.baseArgs()` is `this.socket ? ['-L', this.socket] : []`
 *   (`src/main/tmux/adapter.ts:76-78`, read 2026-08-02), so a falsy
 *   `PRCLI_TMUX_SOCKET` is not a broken socket — it drops `-L` entirely and the
 *   launched app talks to the developer's **default tmux server**, the one
 *   carrying every session they have open;
 * - `killServer` hands its argument straight to `tmux -L <socket> kill-server`,
 *   so `'default'` in one spec's `afterEach` destroys that same server.
 *
 * Neither is a mistake the type checker can see: `''` and `'default'` are both
 * `string`. This prefix is what catches them, and it is checked before anything
 * is launched or killed rather than after.
 */
const SOCKET_PREFIX = 'prcli-e2e'

function assertTestSocket(socket: string): void {
  if (!socket.startsWith(SOCKET_PREFIX)) {
    throw new Error(
      `E2E socket must start with "${SOCKET_PREFIX}", got "${socket}" — ` +
        'an empty or default socket is the developer\'s real tmux server',
    )
  }
}

/**
 * Both spellings of the temp root: `os.tmpdir()` returns `/var/folders/…` on
 * macOS while `/var` is a symlink to `/private/var`, so a caller that had
 * `realpath`'d its own temp dir would fail a check against the raw form alone.
 * `mkdtemp(join(tmpdir(), …))` returns the raw form; both are accepted.
 */
const TMP_ROOTS = [...new Set([tmpdir(), realpathSync(tmpdir())])]

/**
 * The five path overrides must be throwaway paths, not real ones.
 *
 * The token guard in `tests/unit/e2eSafety.test.ts` proves the vars are *set*;
 * it cannot see what they are set *to*, and a `claudeSettings` pointed at the
 * developer's real `~/.claude/settings.json` satisfies it exactly as well as a
 * temp path does. This is that missing half.
 *
 * What it checks is the string, not the directory: it does not verify the path
 * exists, was made by `mkdtemp`, or is unique to one spec. A spec that reused
 * another spec's temp dir would pass this and still interfere. `claudeSettings`
 * is a *file* inside a temp dir rather than a temp dir itself, which is why the
 * test is "under the temp root" and not "is a `mkdtemp` result".
 */
function assertUnderTmp(label: string, value: string): void {
  const path = resolve(value)
  if (!TMP_ROOTS.some((root) => path.startsWith(root + sep))) {
    throw new Error(`E2E ${label} must be under ${tmpdir()}, got "${value}"`)
  }
}

/**
 * The one place the app is launched from.
 *
 * Every one of the five overrides is REQUIRED, not optional-with-a-default.
 * Three of the four spec files went without `PRCLI_CLAUDE_SETTINGS` until
 * 2026-08-02, which meant a single added click on `hooks-install` would have
 * rewritten the developer's real ~/.claude/settings.json. A required
 * parameter is the fix; a default would restore the hole with better manners.
 *
 * `tests/unit/e2eSafety.test.ts` guards both halves of that: that this
 * function's `env` names all five vars, and that nothing else under
 * `tests/e2e/` reaches around it to `electron.launch` on its own.
 *
 * Every override is also checked for *value*, not just presence, before the
 * app is launched — see `assertTestSocket` and `assertUnderTmp` above for what
 * each rejects and why. Rejecting before `electron.launch` is the whole point:
 * the failure modes are things that must not be allowed to happen once.
 */
export async function launchApp(opts: {
  socket: string
  configDir: string
  projectsRoot: string
  claudeSettings: string
  claudeHome: string
  userDataDir: string
}): Promise<ElectronApplication> {
  assertTestSocket(opts.socket)
  assertUnderTmp('configDir', opts.configDir)
  assertUnderTmp('projectsRoot', opts.projectsRoot)
  assertUnderTmp('claudeSettings', opts.claudeSettings)
  assertUnderTmp('claudeHome', opts.claudeHome)
  assertUnderTmp('userDataDir', opts.userDataDir)
  return electron.launch({
    args: [
      '.vite/build/main.js',
      `--user-data-dir=${opts.userDataDir}`,
      // Mitigation, not a fix, for the `firstWindow` flake documented at
      // `projects.spec.ts`'s `launch` const: macOS occasionally blocks an
      // Electron launch in the "reopen windows?" alert before `ready` fires.
      // This pair lands in NSUserDefaults' *argument domain*, which outranks
      // every other domain and applies to this one process only — no global
      // `defaults write` against a bundle id shared with every other Electron
      // tool on the machine, and nothing left behind afterwards. Window
      // restoration is meaningless for a throwaway test profile in any case.
      //
      // **Whether it actually suppresses that alert is UNVERIFIED.** The
      // dialog could not be reproduced on demand (~1 launch in 1,000), so what
      // is confirmed is only that the app still launches and reaches `ready`
      // normally with these arguments present. If a run stalls in
      // `firstWindow` anyway, that is not evidence the cause lies elsewhere —
      // it may simply mean AppKit ignores the argument domain for this prompt.
      '-ApplePersistenceIgnoreState',
      'YES',
    ],
    env: {
      ...process.env,
      // Keep the app's config out of the real ~/.prcli during tests.
      PRCLI_CONFIG_DIR: opts.configDir,
      PRCLI_TMUX_SOCKET: opts.socket,
      // The default root is the developer's real ~/Code. Even the specs that
      // never open the add-project dialog set it: defending a directory that
      // must not be scanned costs one line.
      PRCLI_PROJECTS_ROOT: opts.projectsRoot,
      // Read by every live Claude session on this machine, and one of the two
      // a spec could omit and still pass every assertion it has.
      PRCLI_CLAUDE_SETTINGS: opts.claudeSettings,
      // Holds 73 skills, 36 commands and the plugin registry that every live
      // Claude session on this machine reads. Read-only from the app's side,
      // but a suite resolving against the real one asserts against whatever
      // was installed that week.
      PRCLI_CLAUDE_HOME: opts.claudeHome,
    },
  })
}

/**
 * Destroy one test server. `-L` is not optional and never has been: a bare
 * `kill-server` would take every session the user has open with it. The socket
 * is checked as well as passed — `-L default` is as destructive as no `-L` at
 * all, and this function is called from `afterEach`, where nothing reads its
 * result.
 */
export async function killServer(socket: string): Promise<void> {
  assertTestSocket(socket)
  // No server running. Three of the four specs call this on setup as well as
  // teardown, and on setup there is normally nothing on the socket yet; tmux
  // exits non-zero for that, which is not a failure worth propagating.
  await run('tmux', ['-L', socket, 'kill-server']).catch(() => undefined)
}

/**
 * Every session on one test socket, or `[]` when no server is running there.
 *
 * The empty array is for "no server yet", which is the normal state before the
 * first launch — not a way of turning a tmux failure into a pass. A caller
 * asserting a session exists still fails, because `[]` does not contain it.
 *
 * The socket is checked here too. Listing is read-only and destroys nothing,
 * but a wrong socket would answer a test's question about its own sessions
 * with the developer's real ones — which is the same defect as launching
 * against them, arriving as a passing or failing assertion instead of damage.
 */
export async function sessionNames(socket: string): Promise<string[]> {
  assertTestSocket(socket)
  try {
    const { stdout } = await run('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}
