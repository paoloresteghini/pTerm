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
 * All four are the same class of bug — "this spec can touch state that isn't
 * its own" — so this checks all four rather than only the one that prompted
 * it. Checked against source text, with comments stripped first, so a
 * comment that only *mentions* one of these names cannot satisfy the
 * assertion for a spec that never actually sets it.
 */
const GUARDED_VARS = [
  'PRCLI_CONFIG_DIR',
  'PRCLI_PROJECTS_ROOT',
  'PRCLI_TMUX_SOCKET',
  'PRCLI_CLAUDE_SETTINGS',
]

const E2E_DIR = new URL('../e2e/', import.meta.url)

function readCode(path: URL): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/** Every E2E spec file, enumerated rather than named, so a fifth one is covered the day it lands. */
function e2eSpecs(): string[] {
  return readdirSync(E2E_DIR).filter((name) => name.endsWith('.spec.ts'))
}

describe('every e2e spec keeps its hands off the developer\'s real state', () => {
  it('finds at least one spec to check', () => {
    // [].every(...) is vacuously true. Asserted on its own, first, so a typo
    // in E2E_DIR or the .spec.ts filter can never make the loop below pass by
    // having nothing to iterate over.
    expect(e2eSpecs().length).toBeGreaterThan(0)
  })

  it('sets all four env vars in every spec', () => {
    const specs = e2eSpecs()
    expect(specs.length).toBeGreaterThan(0)
    // Collected across every spec before asserting, rather than failing on
    // the first miss: a single `expect` inside the loop would report only
    // the first offending file and hide the rest behind it.
    const violations: string[] = []
    for (const name of specs) {
      const source = readCode(new URL(name, E2E_DIR))
      for (const envVar of GUARDED_VARS) {
        if (!source.includes(`${envVar}:`)) violations.push(`${name} does not set ${envVar}`)
      }
    }
    expect(violations).toEqual([])
  })
})
