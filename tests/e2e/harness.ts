import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
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
  // Optional, unlike the five above: most specs never touch a shell's rc
  // file, and only the one that does needs to redirect it away from the
  // developer's real ~/.zshrc. Checked under the temp root just the same
  // when a spec does pass it, so there is no way to pass it wrong.
  zshrc?: string
  /*
   * Where the shell inside a pane reads its startup files from, for a spec
   * that cares what its panes' shell actually does.
   *
   * `PRCLI_ZSHRC` above is the file this APP edits; this is the directory the
   * pane's zsh READS, and they are only the same file for a real user. A spec
   * that sets this owns the pane's prompt and the pane's own command history
   * instead of inheriting the developer's, which is what makes an assertion
   * about either of them mean anything on a second machine.
   *
   * How it gets there was measured 2026-08-06 rather than assumed, and it is
   * indirect: nothing in `SessionManager` passes it. Every `-e` it sends tmux
   * carries `PRCLI_TAB_ID` and nothing else (`src/main/sessions/manager.ts`,
   * four sites). What happens instead is that the tmux SERVER is started by
   * this Electron process, inherits its environment into the server's global
   * environment table, and hands that to the sessions it then creates:
   * measured, a `new-session` run with `ZDOTDIR` set produced a pane whose
   * prompt came from that directory's `.zshrc`.
   *
   * The consequence, which a spec using this has to know: it only reaches
   * panes on a server THIS launch started. A server already running on the
   * socket keeps whatever environment it was started with, so a spec must
   * `killServer` before it launches. That is loud rather than silent when it
   * goes wrong (the pane reads a directory that is gone, and the assertion
   * about the prompt fails), which is why `openPane` in `history.spec.ts`
   * waits for the prompt this directory produces before pressing anything.
   *
   * `HISTFILE` is deliberately NOT offered beside it. macOS's `/etc/zshrc`
   * sets `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` unconditionally, so an
   * environment `HISTFILE` is overwritten before any user rc file runs, while
   * `ZDOTDIR` both survives and redirects the history file with it.
   */
  zdotdir?: string
}): Promise<ElectronApplication> {
  assertTestSocket(opts.socket)
  assertUnderTmp('configDir', opts.configDir)
  assertUnderTmp('projectsRoot', opts.projectsRoot)
  assertUnderTmp('claudeSettings', opts.claudeSettings)
  assertUnderTmp('claudeHome', opts.claudeHome)
  assertUnderTmp('userDataDir', opts.userDataDir)
  if (opts.zshrc !== undefined) assertUnderTmp('zshrc', opts.zshrc)
  if (opts.zdotdir !== undefined) assertUnderTmp('zdotdir', opts.zdotdir)
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
      // A run launches this app hundreds of times, and with no window shown
      // the machine stays usable while it runs. See `createWindow`'s
      // `background` for what the main process does with the env var below.
      //
      // These two switches are insurance against Chromium throttling a
      // renderer nobody can see, which is every renderer this run opens. What
      // was measured 2026-08-06 is only that a hidden window keeps painting
      // WITH them (289 rAF callbacks in 2s, the same as a shown one). Whether
      // it would still paint without them was not measured, so do not read
      // their presence as proof they are load-bearing, or their removal as
      // safe.
      ...(process.env.PRCLI_E2E_VISIBLE === '1'
        ? []
        : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']),
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
      // Off in every spec. `scheduleUpdateChecks` otherwise fires ten seconds
      // after each launch, and every spec here launches a real app, so the
      // suite would put a request on api.github.com per launch and its
      // behaviour would depend on GitHub being reachable and on the 60/hour
      // rate limit. Once the update bar exists, an `available` reply would also
      // paint a bar over whatever the spec was asserting on, nondeterministically
      // and in specs that have nothing to do with updates.
      PRCLI_UPDATE_CHECK: '0',
      // On by default, because the default is a run that owns the screen for
      // its whole length. `PRCLI_E2E_VISIBLE=1` puts the window back where a
      // developer can watch it, which is what debugging a spec wants.
      ...(process.env.PRCLI_E2E_VISIBLE === '1' ? {} : { PRCLI_BACKGROUND_WINDOW: '1' }),
      // Only set when a spec asks for it, so `readRc` in every other spec
      // still falls through to its own ENOENT-means-empty branch rather than
      // pointing at a path nothing wrote.
      ...(opts.zshrc !== undefined ? { PRCLI_ZSHRC: opts.zshrc } : {}),
      // Not a PRCLI_ variable: zsh's own, read by the shell in every pane
      // this launch's tmux server starts. See the option's comment for the
      // route it takes and for the one condition it depends on.
      ...(opts.zdotdir !== undefined ? { ZDOTDIR: opts.zdotdir } : {}),
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

/**
 * The visible text of `session`'s current pane, or `''` when it cannot be read.
 *
 * The DOM cannot answer the question the history overlay exists to settle.
 * `Enter` is supposed to put a command ON the prompt without running it, and an
 * overlay that submitted the command would leave the same React tree behind as
 * one that did not. The shell's own screen is the only witness, and this is how
 * a test reads it.
 *
 * `-p` writes the capture to stdout rather than to a paste buffer. What comes
 * back is one line per pane row joined by newlines, padded out to the pane's
 * full height, so a caller comparing against it should split on `'\n'` and
 * reason about lines rather than searching the blob for a substring: measured
 * 2026-08-06, a prompt line holding typed-but-unrun text ends in a newline
 * exactly like a line of output does.
 *
 * The socket is checked for the reason `sessionNames` checks it: this is
 * read-only and destroys nothing, but a wrong socket would answer a test's
 * question with the contents of the developer's real panes.
 */
export async function capturePane(socket: string, session: string): Promise<string> {
  assertTestSocket(socket)
  // Empty for "no server or no such session yet", which is the normal state
  // while a pane is still coming up, and is what lets a caller poll this. It
  // is not a way of passing: '' contains nothing a caller asserts for.
  try {
    const { stdout } = await run('tmux', ['-L', socket, 'capture-pane', '-p', '-t', session])
    return stdout
  } catch {
    return ''
  }
}

/**
 * Expand one of the collapsible columns, which every profile starts without.
 *
 * `App.tsx` collapses Files, Skills, Presets, Notes and Prompts on a fresh
 * profile, and every spec here launches against a fresh `mkdtemp` userDataDir,
 * so a spec that wants to click a skill, a preset or a tree row has to open
 * that column first. Idempotent, so it can be called from a `beforeEach` that
 * shares a page with a test that already opened it.
 *
 * The click is guarded by the panel's own absence rather than by the strip's
 * presence: the strip and the expanded column share a testid on purpose (they
 * are the same control), so clicking it blind would close a column a previous
 * test had opened.
 */
export async function expandColumn(
  page: Page,
  name: 'files' | 'skills' | 'presets' | 'notes' | 'prompts',
): Promise<void> {
  // Wait for the app to have painted BEFORE reading the panel's absence.
  // Without this the count is 0 on a window that has not rendered yet, and on
  // a relaunch, where the collapse state is restored from localStorage and
  // the column may already be open, the click then CLOSES it. Measured: that
  // is exactly how `prompts.spec.ts`'s relaunch test first failed.
  await expect(page.getByTestId(`${name}-toggle`)).toBeVisible()
  if ((await page.getByTestId(`${name}-panel`).count()) > 0) return
  await page.getByTestId(`${name}-toggle`).click()
  await expect(page.getByTestId(`${name}-panel`)).toBeVisible()
}
