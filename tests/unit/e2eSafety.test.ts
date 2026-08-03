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
 * Every E2E spec launches the real app, and five env vars are what keep that
 * launch off the developer's actual machine state rather than a directory
 * `rm -rf`'d at the end of the test: `PRCLI_CONFIG_DIR` (the real `~/.prcli`),
 * `PRCLI_PROJECTS_ROOT` (the real `~/Code`), `PRCLI_TMUX_SOCKET` (the
 * developer's default tmux socket), `PRCLI_CLAUDE_SETTINGS`, and
 * `PRCLI_CLAUDE_HOME` — the latter two read by every live Claude session on
 * the machine, and the two of the five that a spec can omit and still pass
 * every assertion it has, because nothing in the suite ever inspects the
 * real files they would otherwise fall back to.
 *
 * Until 2026-08-02 that env block was copy-pasted into all four specs and this
 * guard asked "does every spec set all four?" — three of the four had drifted
 * and dropped `PRCLI_CLAUDE_SETTINGS`. There is now one launch site,
 * `tests/e2e/harness.ts`, so the question that keeps the property is a
 * different one, in two halves:
 *
 * 1. **`harness.ts` sets all five.** One place, one assertion.
 * 2. **Nothing else under `tests/e2e/` launches Electron on its own.** This is
 *    what replaces the old per-spec token check, and it is the stronger claim:
 *    a caller that goes through `launchApp` inherits all five by construction
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
 * A third property needs no test here: `launchApp`'s six options are
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
 *   own`, which reads the five vars back out of the launched main process and
 *   compares them to the temp paths it made.
 */
const GUARDED_VARS = [
  'PRCLI_CONFIG_DIR',
  'PRCLI_PROJECTS_ROOT',
  'PRCLI_TMUX_SOCKET',
  'PRCLI_CLAUDE_SETTINGS',
  'PRCLI_CLAUDE_HOME',
]

/** Ways of launching Electron that go around `launchApp` and its env block. */
const DIRECT_LAUNCH = ['electron.launch', '_electron']

/**
 * The identifiers a `tmux -L` in this tree is allowed to name.
 *
 * `SOCKET` is the module const every spec declares; `socket` is the parameter
 * `harness.ts` takes and checks. Both are indirections a human has to look
 * through, and looking through them is what the two tests below make
 * unnecessary — a `-L` whose next argument is a string literal is rejected on
 * sight, whatever the literal says.
 */
const SOCKET_IDENTIFIERS = ['SOCKET', 'socket']

/** What must follow a `'-L'` in the argument array: `, SOCKET` or `, socket`. */
const TAKES_SOCKET = new RegExp(`^\\s*,\\s*(?:${SOCKET_IDENTIFIERS.join('|')})\\s*[,\\]]`)

/** A bare `'-L'` string literal, in any of the three quote styles. */
const MINUS_L = /(['"`])-L\1/g

/**
 * `tmux -Lname`, the glued spelling — a string literal beginning `-L` and
 * carrying the socket name inside it, so the check above has no next argument
 * to look at. tmux accepts it. Nothing here uses it, and it is rejected rather
 * than parsed: a form this file cannot see into is a form that should not be
 * the one a copy reaches for.
 */
const GLUED_MINUS_L = /(['"`])-L[^'"`]+\1/g

/** `const SOCKET = '…'` — the module const a `-L` is allowed to name. */
const SOCKET_CONST = /\b(?:const|let|var)\s+(?:SOCKET|socket)\s*=\s*(['"`])([^'"`]*)\1/g

/**
 * A `'tmux'` literal followed by its argument array — `run('tmux', [ … ])`,
 * `execFile('tmux', [ … ])`, whatever the wrapper is called.
 *
 * The checks above look at a `-L` and ask what follows it. This one looks at a
 * tmux invocation and asks whether there is a `-L` in it AT ALL, which is a
 * different question with a worse answer when it is missing: `tmux
 * kill-server` with no socket flag is not a broken command, it is a working
 * command aimed at `/tmp/tmux-$UID/default`.
 */
const TMUX_CALL = /(['"`])tmux\1\s*,\s*/g

/** A `-L` anywhere in an argument array. */
const HAS_MINUS_L = /(['"`])-L\1/

/**
 * `-S`, which names the socket by PATH rather than by name and so reaches the
 * same server `-L default` does, spelled differently. Case-sensitive on
 * purpose: `-s` is `new-session`'s name flag and two specs pass it.
 */
const HAS_MINUS_S = /(['"`])-S\1/

/**
 * The argument array beginning at `from`, or `null` when what is there is not
 * a literal array.
 *
 * Bracket depth rather than "up to the first `]`", so a nested array cannot
 * end the slice early and hide everything after it. `null` — a tmux call whose
 * arguments are built somewhere this check cannot read — is a violation rather
 * than a pass, because the whole point is that an unreadable socket is an
 * unchecked one.
 */
function argArray(source: string, from: number): string | null {
  if (source[from] !== '[') return null
  let depth = 0
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  return null
}

/**
 * The prefix a socket literal must carry, duplicated from `harness.ts`'s own
 * `SOCKET_PREFIX` on purpose: importing it would make this test agree with the
 * harness by construction even if both were changed to `default` together.
 */
const SOCKET_PREFIX = 'prcli-e2e'

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

/**
 * Every `.ts` under `tests/e2e/` **including `harness.ts`**.
 *
 * The launch check excludes the harness because the harness is the one place
 * allowed to say `electron.launch`. There is no such exemption for `-L`: the
 * harness's own two `-L` sites pass the check below today (`['-L', socket, …]`,
 * the parameter `assertTestSocket` has already vetted), and including it costs
 * nothing while catching a harness that ever started writing the socket in.
 */
function allE2eFiles(): string[] {
  return [...e2eFiles(), ALLOWED_LAUNCH_SITE]
}

/**
 * Comments out, then whitespace flattened, so a `-L` and the argument after it
 * read the same whether they sit on one line or four. The two token checks
 * above read the unflattened form because a bare `includes` does not care;
 * these two look at what FOLLOWS a token, and do.
 */
function readFlat(path: URL): string {
  return readCode(path).replace(/\s+/g, ' ')
}

describe('the E2E suite keeps its hands off the developer\'s real state', () => {
  it('sets all five env vars in the one place the app is launched from', () => {
    const source = readCode(HARNESS)
    // Non-empty first, both of them: a missing or emptied harness.ts, or a
    // GUARDED_VARS somebody trimmed to nothing, would otherwise leave the
    // filter below with nothing to find and pass on an empty array.
    expect(source.trim().length).toBeGreaterThan(0)
    expect(GUARDED_VARS.length).toBe(5)
    expect(GUARDED_VARS.filter((envVar) => !source.includes(`${envVar}:`))).toEqual([])
  })

  it('places PRCLI_CLAUDE_HOME under the temp root at the one launch site', () => {
    // ~/.claude holds 73 skills, 36 commands and the plugin registry that
    // every live Claude session on this machine reads. The app only ever
    // reads it, so the failure this prevents is not destruction — it is a
    // suite whose assertions depend on whatever was installed that week.
    const harness = readCode(HARNESS)
    expect(harness).toContain('PRCLI_CLAUDE_HOME: opts.claudeHome')
    expect(harness).toContain("assertUnderTmp('claudeHome', opts.claudeHome)")
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

  /**
   * `launchApp`, `killServer` and `sessionNames` are checked at runtime by
   * `harness.ts`. Four specs also run `tmux` directly, around the harness
   * entirely — `splits.spec.ts`'s `windowCols` and `panePid`,
   * `status.spec.ts`'s kill-session and send-keys, `tabs.spec.ts`'s three,
   * `projects.spec.ts`'s new-session — and nothing checked those at all.
   *
   * Today every one of them passes `SOCKET`, a fixed module const, so today
   * this test finds nothing. It is here because of what landed on 2026-08-02:
   * `splits.spec.ts` introduced the first `kill` in the E2E tree, `run('kill',
   * ['-9', await panePid(victim)])`, and `panePid` derives that pid from a
   * `tmux -L` listing. The pattern is now in the tree to be copied, and a copy
   * that reached for `'default'` instead of `SOCKET` would not fail an
   * assertion — it would signal the developer's own running work on the tmux
   * server carrying all of it. That is not a class of mistake worth catching
   * once it has happened.
   *
   * **What this does NOT catch**, stated rather than implied:
   *
   * - a `-L` inside a shell string handed to `execFile('sh', ['-c', …])`. The
   *   check reads argument arrays, not strings that a shell will re-split;
   * - `tmux` invoked from outside `tests/e2e/` entirely;
   * - the value behind the identifier, which is what the SOCKET-const test
   *   below covers, and only to the extent stated there.
   *
   * A `tmux` call carrying NO socket flag used to be on this list, attributed
   * to inheriting `$TMUX`. That was the wrong mechanism for the dangerous
   * case and is now caught outright — see the third test below.
   */
  it('names a checked socket at every -L in the tree, never a literal', () => {
    const files = allE2eFiles()
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    let sites = 0
    for (const name of files) {
      const source = readFlat(new URL(name, E2E_DIR))
      for (const match of source.matchAll(MINUS_L)) {
        sites += 1
        const after = source.slice(match.index + match[0].length)
        if (!TAKES_SOCKET.test(after)) {
          violations.push(
            `${name}: -L is followed by ${JSON.stringify(after.slice(0, 24))}, not one of ` +
              `${SOCKET_IDENTIFIERS.join('/')}`,
          )
        }
      }
      for (const match of source.matchAll(GLUED_MINUS_L)) {
        violations.push(`${name}: ${match[0]} hides the socket inside the flag`)
      }
    }
    // The non-vacuity pin, and the whole reason this assertion is not
    // self-satisfying: with no `-L` anywhere the loop above finds nothing and
    // `violations` is `[]` for the wrong reason. A rename of the flag, a
    // move of every tmux call behind a helper, or a broken `MINUS_L` would
    // each empty this silently. There are 10 sites across five files as this
    // is written; the bound is left loose so that adding a tmux call is not a
    // test edit, and tightening it to a count would only move the silence.
    expect(sites).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  /**
   * The check above proves a `-L` names `SOCKET`; this one narrows what
   * `SOCKET` may be declared as.
   *
   * Without it, that check is satisfied by `const SOCKET = 'default'` plus
   * every `-L` naming it faithfully, which is a worse outcome than the
   * hardcoded literal it was written to catch — the same damage with an
   * indirection in front of it.
   *
   * **The two do not add up to completeness, and an earlier draft of this
   * comment said they did.** Both of these pass all three static checks:
   *
   * - a socket built by CONCATENATION — `const SOCKET = base + 'default'`, or
   *   a template with a hole in it. `SOCKET_CONST` requires a quote directly
   *   after the `=`, so it counts no declaration at all and the `-L` half sees
   *   only a well-behaved identifier;
   * - a `SOCKET` IMPORTED from outside `tests/e2e/`. Nothing outside that
   *   directory is scanned, so the declaration is never read.
   *
   * What actually closes both is not static: each spec hands `SOCKET` to
   * `killServer` and `launchApp`, which call `assertTestSocket` and throw in
   * `beforeEach`, before anything is launched or killed. So the residual hole
   * is a spec that runs tmux directly and calls NEITHER — which is a narrow
   * shape, and a stated one, rather than a shape these tests can rule out.
   */
  it('declares no SOCKET outside the suite\'s own namespace', () => {
    const files = allE2eFiles()
    const violations: string[] = []
    let declarations = 0
    for (const name of files) {
      for (const match of readFlat(new URL(name, E2E_DIR)).matchAll(SOCKET_CONST)) {
        declarations += 1
        if (!match[2].startsWith(SOCKET_PREFIX)) {
          violations.push(`${name}: SOCKET = ${JSON.stringify(match[2])}`)
        }
      }
    }
    // Same pin, same reason: five specs declare one each today, and a regex
    // that matched none of them would otherwise report an empty violation
    // list as a pass.
    expect(declarations).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  /**
   * The gap both checks above leave wide open: a `tmux` call with no socket
   * flag at all.
   *
   * `MINUS_L` only inspects invocations that already have a `-L`, so
   * `run('tmux', ['kill-server'])` is not a violation to it — there is nothing
   * for it to look at. And that command is not inert. tmux with no `-L` and no
   * `-S` falls back to `/tmp/tmux-$UID/default`, the developer's real server,
   * the one carrying every session they have open. `$TMUX` does not enter into
   * it: a spec launched from a plain shell has no `$TMUX` set and still lands
   * on `default`. It is the single command this project forbids outright, and
   * the guard written to enforce socket scoping did not catch it.
   *
   * `-S` is the same server reached by path — `['-S', '/tmp/tmux-501/default']`
   * — and is rejected rather than inspected. Nothing in the tree uses it
   * (verified 2026-08-03 across all five files), so rejecting outright costs
   * nothing and there is no second spelling of "which server" to keep correct.
   *
   * A tmux call whose arguments are not a readable literal array —
   * `run('tmux', buildArgs())` — is a violation too, for the reason the first
   * check could only declare: arguments this file cannot read are arguments it
   * cannot vouch for, and passing them would be a guess.
   *
   * **What this still does not catch:** tmux reached through a shell string
   * (`execFile('sh', ['-c', 'tmux kill-server'])`), a binary other than the
   * literal `'tmux'` (an absolute path, or a variable holding the name), and
   * anything outside `tests/e2e/`.
   */
  it('runs no tmux without -L, and never names the socket by path', () => {
    const files = allE2eFiles()
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    let calls = 0
    for (const name of files) {
      const source = readFlat(new URL(name, E2E_DIR))
      for (const match of source.matchAll(TMUX_CALL)) {
        calls += 1
        const args = argArray(source, match.index + match[0].length)
        if (args === null) {
          violations.push(`${name}: tmux arguments are not a literal array, so the socket is unreadable`)
          continue
        }
        if (!HAS_MINUS_L.test(args)) {
          violations.push(
            `${name}: tmux with no -L reaches the developer's default server: ${args.slice(0, 40)}`,
          )
        }
        if (HAS_MINUS_S.test(args)) {
          violations.push(`${name}: tmux -S names the socket by path: ${args.slice(0, 40)}`)
        }
      }
    }
    // The same pin as the two above, and it does more work here than in
    // either: this check finds its subjects by the string `'tmux'`, so a
    // wrapper that stopped spelling the binary out would leave every call
    // uninspected and this list empty. 10 calls across five files as this is
    // written, all of them `-L SOCKET`.
    expect(calls).toBeGreaterThan(0)
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
  claudeHome: join(tmpdir(), 'prcli-unit-claude-home'),
  userDataDir: join(tmpdir(), 'prcli-unit-user'),
})

// Strings only. Nothing in this file reads, writes or lists any of these — they
// exist to be rejected, which is the entire point.
const REAL_CONFIG_DIR = join(homedir(), '.prcli')
const REAL_PROJECTS_ROOT = join(homedir(), 'Code')
const REAL_CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')
const REAL_CLAUDE_HOME = join(homedir(), '.claude')

const launchMock = vi.mocked(electron.launch)

describe('the harness rejects a real socket or a real path before it launches anything', () => {
  beforeEach(() => {
    launchMock.mockClear()
    execFileSpy.mockClear()
  })

  // The control. Without it every assertion below would also pass if the
  // harness had been made to reject everything, valid arguments included —
  // which would be a broken harness reported as a safe one.
  it('launches when the socket and all five paths are throwaway ones', async () => {
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
    ['claudeHome', { ...safeOpts(), claudeHome: REAL_CLAUDE_HOME }, 'claudeHome'],
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
