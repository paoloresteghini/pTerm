import { readdirSync, readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

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
 * 2. **No spec launches Electron on its own.** This is what replaces the old
 *    per-spec token check, and it is the stronger claim: a spec that goes
 *    through `launchApp` inherits all four by construction and needs no token
 *    check, while a spec reaching for `electron.launch` has stepped around the
 *    harness — which is exactly the fifth-spec hazard the original guard
 *    existed to catch. The specs are enumerated, not named, so that fifth spec
 *    is covered the day it lands.
 *
 * A third property needs no test here: `launchApp`'s five options are
 * required, not optional-with-defaults, so `tsc --noEmit` rejects a caller
 * that omits one. A default would restore the hole with better manners.
 *
 * Both halves read source text with comments stripped first, so a comment that
 * only *mentions* a var name — or one that mentions `electron.launch` while
 * describing the harness — can neither satisfy nor trip an assertion.
 *
 * **What this does NOT catch**, stated rather than implied: a spec that
 * launches the app by some third route naming neither token (spawning the
 * packaged binary itself, say), and a var pointed at the wrong path — a
 * `PRCLI_CLAUDE_SETTINGS` set to the developer's real file satisfies the token
 * check exactly as well as a temp path does. That second one is covered at
 * runtime instead, by `launch.spec.ts`'s `runs against overridden paths, never
 * the developer's own`, which reads the four vars back out of the launched
 * main process and compares them to the temp paths it made.
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

/** Every E2E spec file, enumerated rather than named, so a fifth one is covered the day it lands. */
function e2eSpecs(): string[] {
  return readdirSync(E2E_DIR).filter((name) => name.endsWith('.spec.ts'))
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

  it('launches every spec through that harness, never Electron directly', () => {
    const specs = e2eSpecs()
    // [].every(...) is vacuously true, and so is a loop over nothing. Asserted
    // first so a typo in E2E_DIR or the .spec.ts filter can never make the
    // loop below pass by having nothing to iterate over.
    expect(specs.length).toBeGreaterThan(0)
    expect(DIRECT_LAUNCH.length).toBeGreaterThan(0)
    // Collected across every spec before asserting, rather than failing on
    // the first miss: a single `expect` inside the loop would report only
    // the first offending file and hide the rest behind it.
    const violations: string[] = []
    for (const name of specs) {
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
