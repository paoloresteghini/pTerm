import { _electron as electron } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { launchApp, killServer, sessionNames } from '../e2e/harness'

// `launchApp`'s job is to start Electron and `killServer`'s is to run tmux, so
// the only way to test what they do *before* that — which is the entire subject
// of the second describe below — is for neither to be the real one. Nothing in
// this file starts an app or reaches a tmux socket, and that is not squeamish-
// ness: the arguments under test here include the developer's real tmux server.
vi.mock('@playwright/test', () => ({
  _electron: { launch: vi.fn(async () => ({ mocked: true })) },
}))

const execFileSpy = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  // Callback-style, because the harness wraps this in `promisify`. It always
  // succeeds; what a real tmux would have said is not what these tests ask.
  execFile: (...args: unknown[]) => {
    const done = args[args.length - 1] as (err: null, out: { stdout: string; stderr: string }) => void
    execFileSpy(...args.slice(0, -1))
    done(null, { stdout: '', stderr: '' })
  },
}))

/**
 * Every E2E spec launches the real app, and four env vars are what keep that
 * launch off the developer's actual machine state rather than a directory
 * `rm -rf`'d at the end of the test: `PRCLI_CONFIG_DIR` (the real `~/.prcli`),
 * `PRCLI_PROJECTS_ROOT` (the real `~/Code`), `PRCLI_TMUX_SOCKET` (the
 * developer's default tmux socket), and `PRCLI_CLAUDE_SETTINGS` — read by
 * every live Claude session on the machine, and the one of the four that a
 * spec can omit and still pass every assertion it has, because nothing in
 * the suite ever inspects the real file it would otherwise fall back to.
 *
 * Until 2026-08-02 that env block was copy-pasted into all four specs and this
 * guard asked "does every spec set all four?" — three of the four had drifted
 * and dropped `PRCLI_CLAUDE_SETTINGS`. There is now one launch site,
 * `tests/e2e/harness.ts`, so the question that keeps the property is a
 * different one, in two halves:
 *
 * 1. **`harness.ts` sets all four.** One place, one assertion.
 * 2. **Nothing else under `tests/e2e/` launches Electron on its own.** This is
 *    what replaces the old per-spec token check, and it is the stronger claim:
 *    a caller that goes through `launchApp` inherits all four by construction
 *    and needs no token check, while one reaching for `electron.launch` has
 *    stepped around the harness — which is exactly the fifth-spec hazard the
 *    original guard existed to catch. Every `.ts` file in the directory *and
 *    any subdirectory of it* is enumerated except `harness.ts` itself — see
 *    `e2eFiles` for why the recursion is load-bearing — and not only the
 *    `.spec.ts` ones: until
 *    2026-08-02 all launch code did live in `.spec.ts` files, so a `.spec.ts`
 *    filter was complete — but this suite now keeps its launch code in a
 *    non-spec helper, and under that filter a *second* helper (`dragHarness.ts`,
 *    say) could call `electron.launch` with no overrides at all and leave this
 *    file green. Verified 2026-08-02 by planting exactly that file: 2 passed
 *    before the filter was widened, 1 failed after. Enumerated rather than
 *    named, so a fifth spec or a new helper is covered the day it lands.
 *
 * A third property needs no test here: `launchApp`'s five options are
 * required, not optional-with-defaults, so `tsc --noEmit` rejects a caller
 * that omits one. A default would restore the hole with better manners.
 *
 * Both halves read source text with comments stripped first, so a comment that
 * only *mentions* a var name — or one that mentions `electron.launch` while
 * describing the harness — can neither satisfy nor trip an assertion.
 *
 * A var pointed at the *wrong path* is a hole neither half can see: a
 * `PRCLI_CLAUDE_SETTINGS` set to the developer's real file satisfies the token
 * check exactly as well as a temp path does, and so does a `PRCLI_TMUX_SOCKET`
 * of `''` — which is not "no socket" but the developer's default tmux server,
 * because `TmuxAdapter.baseArgs()` drops `-L` when the socket is falsy. That is
 * what the second describe below covers: `launchApp` and `killServer` now
 * reject a non-`prcli-e2e` socket and any override outside the temp root, and
 * these tests pin that the rejection happens *before* `electron.launch` is
 * reached. They run against a mocked `electron.launch`, deliberately: the point
 * of the guard is a thing that must not be allowed to happen even once, so the
 * bad values are asserted about, never executed.
 *
 * **What this does NOT catch**, stated rather than implied:
 *
 * - a spec that launches the app by some third route naming neither token
 *   (spawning the packaged binary itself, say);
 * - a temp path that is real but *shared* — the harness checks that each
 *   override sits under `os.tmpdir()`, not that it is a fresh `mkdtemp` unique
 *   to one spec, so two specs pointed at one directory would pass;
 * - what the launched app actually receives. The harness assertions read the
 *   arguments, not the main process. That is covered at runtime instead, by
 *   `launch.spec.ts`'s `runs against overridden paths, never the developer's
 *   own`, which reads the four vars back out of the launched main process and
 *   compares them to the temp paths it made.
 */
const GUARDED_VARS = [
  'PRCLI_CONFIG_DIR',
  'PRCLI_PROJECTS_ROOT',
  'PRCLI_TMUX_SOCKET',
  'PRCLI_CLAUDE_SETTINGS',
]

/** Ways of launching Electron that go around `launchApp` and its env block. */
const DIRECT_LAUNCH = ['electron.launch', '_electron']

const E2E_DIR = new URL('../e2e/', import.meta.url)
const HARNESS = new URL('harness.ts', E2E_DIR)

function readCode(path: URL): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/** The one file allowed to say `electron.launch`, as a path relative to `E2E_DIR`. */
const ALLOWED_LAUNCH_SITE = 'harness.ts'

/**
 * Every `.ts` file under `tests/e2e/`, at any depth, except the harness itself.
 *
 * **Recursive**, and that is not tidiness. Playwright's discovery under
 * `testDir: './tests/e2e'` descends into subdirectories — measured 2026-08-02 by
 * planting `tests/e2e/helpers/probe.spec.ts` and running `npx playwright test
 * --list`, which reported `helpers/probe.spec.ts:2:5` and `Total: 36 tests in 5
 * files`. So a flat read would leave `tests/e2e/helpers/dragHarness.ts` free to
 * call `electron.launch` with no overrides, run as part of the suite, and be
 * invisible here — the same hole this file closed on 2026-08-02, one directory
 * deeper. Measured the same way: with that file planted, a flat read left this
 * file at 13 passed.
 *
 * Names are returned relative to `E2E_DIR` (`helpers/dragHarness.ts`), which is
 * both what `new URL(name, E2E_DIR)` wants and what makes the exclusion below an
 * exact path rather than a basename: a `helpers/harness.ts` is *not* the allowed
 * launch site and is checked like anything else.
 */
function e2eFiles(dir: URL = E2E_DIR, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      found.push(...e2eFiles(new URL(`${entry.name}/`, dir), `${relative}/`))
    } else if (relative.endsWith('.ts') && relative !== ALLOWED_LAUNCH_SITE) {
      found.push(relative)
    }
  }
  return found
}

describe('the E2E suite keeps its hands off the developer\'s real state', () => {
  it('sets all four env vars in the one place the app is launched from', () => {
    const source = readCode(HARNESS)
    // Non-empty first, both of them: a missing or emptied harness.ts, or a
    // GUARDED_VARS somebody trimmed to nothing, would otherwise leave the
    // filter below with nothing to find and pass on an empty array.
    expect(source.trim().length).toBeGreaterThan(0)
    expect(GUARDED_VARS.length).toBe(4)
    expect(GUARDED_VARS.filter((envVar) => !source.includes(`${envVar}:`))).toEqual([])
  })

  it('launches every E2E file through that harness, never Electron directly', () => {
    const files = e2eFiles()
    // [].every(...) is vacuously true, and so is a loop over nothing. Asserted
    // first so a typo in E2E_DIR or the .ts filter can never make the loop
    // below pass by having nothing to iterate over.
    expect(files.length).toBeGreaterThan(0)
    expect(DIRECT_LAUNCH.length).toBeGreaterThan(0)
    // Collected across every file before asserting, rather than failing on
    // the first miss: a single `expect` inside the loop would report only
    // the first offending file and hide the rest behind it.
    const violations: string[] = []
    for (const name of files) {
      const source = readCode(new URL(name, E2E_DIR))
      for (const token of DIRECT_LAUNCH) {
        if (source.includes(token)) {
          violations.push(`${name} uses ${token} instead of the harness's launchApp`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

type LaunchOpts = Parameters<typeof launchApp>[0]

/** Every override a throwaway path, and a socket in the suite's own namespace. */
const safeOpts = (): LaunchOpts => ({
  socket: 'prcli-e2e-unit',
  configDir: join(tmpdir(), 'prcli-unit-config'),
  projectsRoot: join(tmpdir(), 'prcli-unit-root'),
  claudeSettings: join(tmpdir(), 'prcli-unit-settings', 'settings.json'),
  userDataDir: join(tmpdir(), 'prcli-unit-user'),
})

// Strings only. Nothing in this file reads, writes or lists any of these — they
// exist to be rejected, which is the entire point.
const REAL_CONFIG_DIR = join(homedir(), '.prcli')
const REAL_PROJECTS_ROOT = join(homedir(), 'Code')
const REAL_CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')

const launchMock = vi.mocked(electron.launch)

describe('the harness rejects a real socket or a real path before it launches anything', () => {
  beforeEach(() => {
    launchMock.mockClear()
    execFileSpy.mockClear()
  })

  // The control. Without it every assertion below would also pass if the
  // harness had been made to reject everything, valid arguments included —
  // which would be a broken harness reported as a safe one.
  it('launches when the socket and all four paths are throwaway ones', async () => {
    await launchApp(safeOpts())
    expect(launchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an empty socket, which drops tmux\'s -L and means the real default server', ''],
    ['the default socket by name', 'default'],
    ['a socket that only nearly matches the prefix', 'prcli-e2'],
  ])('refuses %s', async (_label, socket) => {
    await expect(launchApp({ ...safeOpts(), socket })).rejects.toThrow(
      /E2E socket must start with "prcli-e2e"/,
    )
    // The throw has to come first, not merely happen: an app already launched
    // against the developer's tmux server cannot be un-launched by an error.
    expect(launchMock).not.toHaveBeenCalled()
  })

  it.each<[string, LaunchOpts, string]>([
    ['configDir', { ...safeOpts(), configDir: REAL_CONFIG_DIR }, 'configDir'],
    ['projectsRoot', { ...safeOpts(), projectsRoot: REAL_PROJECTS_ROOT }, 'projectsRoot'],
    ['claudeSettings', { ...safeOpts(), claudeSettings: REAL_CLAUDE_SETTINGS }, 'claudeSettings'],
    ['userDataDir', { ...safeOpts(), userDataDir: homedir() }, 'userDataDir'],
  ])('refuses a %s outside the temp root', async (_label, opts, named) => {
    await expect(launchApp(opts)).rejects.toThrow(`E2E ${named} must be under`)
    expect(launchMock).not.toHaveBeenCalled()
  })

  // `killServer` is the other half, and the destructive one: it runs
  // `tmux -L <socket> kill-server` on whatever it is handed, so 'default' here
  // would take every session the developer has open. The spy assertion is the
  // load-bearing one — a rejection that happened after the spawn would be no
  // use at all.
  it.each([[''], ['default']])('refuses to kill-server on socket "%s"', async (socket) => {
    await expect(killServer(socket)).rejects.toThrow(/E2E socket must start with "prcli-e2e"/)
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  // The matching control: a socket in the suite's namespace is allowed through,
  // with `-L` and the socket name intact.
  it('kills a prcli-e2e socket, passing -L through', async () => {
    await expect(killServer('prcli-e2e-unit')).resolves.toBeUndefined()
    expect(execFileSpy).toHaveBeenCalledWith('tmux', ['-L', 'prcli-e2e-unit', 'kill-server'])
  })

  // `sessionNames` is the defence-in-depth case, and it is pinned because an
  // unpinned assertion is one that can be deleted in silence: when the seven
  // `assert*` call sites were mutated out on 2026-08-02, this one produced no
  // failure at all while the other six produced nine. Listing cannot destroy
  // anything — the harm it avoids is a test being answered about the
  // developer's real sessions instead of its own, which arrives as a passing or
  // failing assertion rather than as damage. The check sits outside the
  // function's `try`, so it rejects rather than being swallowed into the `[]`
  // that "no server running" returns.
  it.each([[''], ['default']])('refuses to list sessions on socket "%s"', async (socket) => {
    await expect(sessionNames(socket)).rejects.toThrow(/E2E socket must start with "prcli-e2e"/)
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  it('lists sessions on a prcli-e2e socket, passing -L through', async () => {
    await expect(sessionNames('prcli-e2e-unit')).resolves.toEqual([])
    expect(execFileSpy).toHaveBeenCalledWith('tmux', [
      '-L',
      'prcli-e2e-unit',
      'list-sessions',
      '-F',
      '#{session_name}',
    ])
  })
})
