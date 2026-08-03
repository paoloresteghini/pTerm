# M4 Plan 2: Skills Panel and ⌘K Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the 161 skills and commands `listSkills` returns in front of the
user, in a filterable panel section and a ⌘K palette, so clicking one types the
string they would have typed.

**Architecture:** One pure matcher module (`src/renderer/lib/match.ts`) ranks and
orders entries and is the only ranking rule in the codebase. `RightPanel` gains a
Skills section above Presets that fetches on mount and filters through that
matcher. A new `CommandPalette` on the existing Radix `Dialog` primitive lists
live panes first and matched actions below, bound to ⌘K in `App`'s existing
keydown handler.

**Tech Stack:** TypeScript (strict), React, Radix `Dialog`, Tailwind, vitest for
the pure module, Playwright for both surfaces.

## Global Constraints

- **No new dependencies.** `npm install` / `npm ci` must not be run: it breaks
  node-pty's spawn-helper permissions and fails every integration test until the
  postinstall repairs it. Everything here uses React, Radix and Tailwind, all
  already present.
- **No em dashes** in code, comments, copy or commit messages. Use a colon,
  comma, parenthesis or separate sentence. Precedent commit `178af6c`.
- **Assert the observable, not the mechanism.**
- **Never assert over a collection without first asserting it is non-empty.** A
  broken fetch renders zero rows and every `toContain` over them passes
  vacuously.
- **A comment asserting a mechanism that is not true is a defect** equal to a
  code defect. This repo has shipped that defect four times. Where a comment
  states a count or a "the only" claim, prefer wording that cannot go stale.
- Node built-ins are imported with the `node:` prefix. TypeScript strict;
  `npm run typecheck` must stay clean at every commit in this plan.
- Tests are vitest. Pure tests in `tests/unit/`, disk-touching in
  `tests/integration/`. Run one file with `npx vitest run <path>`.
- **There are no React rendering tests in this repo and none are to be added.**
  No `@testing-library`, no `react-dom/test-utils`. Pure logic is unit tested;
  rendered behaviour is E2E. That division is why Task 1 exists as its own
  module.
- E2E specs use `-L prcli-e2e*` sockets only. A bare `kill-server` is forbidden.
  Never touch the real `~/.prcli`, `~/Code`, `~/.claude/settings.json`, or the
  `default` tmux socket.
- **Nothing in this plan writes `~/.claude`.** Only `src/main/hooks/install.ts`
  may ever write that directory. The panel and palette are read-only consumers.
- **`expect.poll` and `toHaveCount` return on their first match and cannot
  assert that something did not happen.** For any negative claim, settle first,
  then assert the contents plainly. This repo has already had a false pass from
  exactly that mistake.

## Baseline

`master` at `11f5482` or later. Before this plan: **1158 tests across 41 files**,
**E2E 44**, typecheck and `check-deps` clean.

## What Plan 1b already landed, and what it did not

`window.prcli.skills(projectCwd)` returns `SkillEntry[]`, each already carrying
the exact string a user types:

```ts
export type SkillOrigin = { kind: 'user' } | { kind: 'repo' } | { kind: 'plugin'; plugin: string }

export interface SkillEntry {
  /** What gets typed into a pane, without the leading slash. */
  name: string
  description: string
  kind: 'skill' | 'command'
  source: SkillOrigin
}
```

Measured on the target machine 2026-08-03, through the shipped module: **161
entries** (119 skills, 42 commands), 21 enabled plugin roots, **zero collisions
among the 161 emitted names**.

**One thing the spec states more strongly than is true.** The spec lists
"deduplication of entry names, dissolved by Plan 1b" as out of scope. Plan 1b
dissolved the collision class it caused (two directories declaring the same
frontmatter `name`). It did **not** make uniqueness structural: a user skill
directory `foo/` and a user command `foo.md` both emit `foo`, and a plugin's
`sp/skills/x/` and `sp/commands/x.md` both emit `sp:x`. Zero such collisions
exist today, and this plan does not deduplicate. It simply never uses `name` as
a React key. Task 2 and Task 4 key rows on a composite instead, so a collision
that appears later renders two honest rows rather than throwing a duplicate-key
warning or dropping one.

## File Structure

| File | Change |
|---|---|
| Create `src/renderer/lib/match.ts` | The one ranking rule: `scoreEntry`, `byName`, `filterEntries`, `rankSessions`. Pure, no React, no DOM. |
| Create `tests/unit/match.test.ts` | Unit tests for every export, including the ordering rule and the gap-penalty cap. |
| Modify `src/renderer/RightPanel.tsx` | A Skills section above Presets, with a filter input, using `filterEntries`. |
| Modify `src/renderer/App.tsx` | Pass `onInsert` to `RightPanel`; add the ⌘K branch; mount `CommandPalette`. |
| Create `src/renderer/CommandPalette.tsx` | The palette, on the existing `Dialog` primitive. |
| Create `src/renderer/lib/tabLabel.ts` | The tab-naming rule, extracted from the two identical private copies in `TabBar.tsx` and `DeadPane.tsx` so the palette is not a third. |
| Modify `src/renderer/TabBar.tsx`, `src/renderer/DeadPane.tsx` | Use the extracted `tabLabel`, rendering the same strings as before. |
| Create `tests/e2e/skills.spec.ts` | Both surfaces, against a fixture `~/.claude` with known entries. |

---

### Task 1: The matcher

**Files:**
- Create: `src/renderer/lib/match.ts`
- Test: `tests/unit/match.test.ts`

**Interfaces:**
- Consumes: `SkillEntry` from `../../shared/ipc`.
- Produces, relied on by Tasks 2 and 4:
  - `byName(a: { name: string }, b: { name: string }): number`
  - `scoreEntry(query: string, name: string): number | null`
  - `filterEntries<T extends { name: string }>(query: string, entries: T[]): T[]`
  - `rankSessions<T extends { name: string; severity: number }>(query: string, sessions: T[]): T[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/match.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { byName, scoreEntry, filterEntries, rankSessions } from '../../src/renderer/lib/match'

describe('scoreEntry', () => {
  it('returns null when a query character is absent', () => {
    expect(scoreEntry('zz', 'brainstorming')).toBeNull()
  })

  it('matches characters out of adjacency but in order', () => {
    // `bsm` is a subsequence of `brainstorming`. This is the whole point of a
    // fuzzy filter: nobody types the middle of a long plugin name.
    expect(scoreEntry('bsm', 'brainstorming')).not.toBeNull()
  })

  it('refuses a query whose characters are in the wrong order', () => {
    expect(scoreEntry('mb', 'brainstorming')).toBeNull()
  })

  it('is case insensitive in both directions', () => {
    expect(scoreEntry('BR', 'brainstorming')).not.toBeNull()
    expect(scoreEntry('br', 'BRAINSTORMING')).not.toBeNull()
  })

  it('scores a contiguous run above the same characters scattered', () => {
    // Both names place the query characters at the same first index and the
    // same last index, and skip three characters in total either way, so the
    // ONLY difference between them is that two characters are adjacent in the
    // first. Remove the adjacency bonus and the two score identically, which
    // is what makes this assertion pin that bonus and nothing else.
    //
    // A realistic-looking pair does not work here, and was tried:
    // `bra` against `brainstorming` and `boring-random-away` scores 8 against
    // 3 with the bonus removed, so it passes either way. It reads better and
    // measures nothing. The synthetic pair is the honest one.
    const contiguous = scoreEntry('abc', 'xabqqc')
    const scattered = scoreEntry('abc', 'xaqbqc')
    expect(contiguous).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(contiguous as number).toBeGreaterThan(scattered as number)
  })

  it('scores a segment start above a match buried mid-word', () => {
    // `:` and `-` start a segment. `superpowers:brainstorming` is why: typing
    // `b` should favour the entry where `b` begins a segment.
    const boundary = scoreEntry('b', 'superpowers:brainstorming')
    const buried = scoreEntry('b', 'aaab')
    expect(boundary).not.toBeNull()
    expect(buried).not.toBeNull()
    expect(boundary as number).toBeGreaterThan(buried as number)
  })

  it('keeps a segment start ahead however far into the name it sits', () => {
    // The bug this pins: the skip cost once grew with position without limit
    // while the segment bonus stayed fixed, so a segment start far into a long
    // name lost to a buried match near the front of a short one. Distance must
    // not be able to outweigh starting a segment.
    const far = scoreEntry('b', 'solutions-architect-skills:business-continuity')
    const near = scoreEntry('b', 'aab')
    expect(far).not.toBeNull()
    expect(near).not.toBeNull()
    expect(far as number).toBeGreaterThan(near as number)
  })

  it('scores an empty query as zero rather than refusing it', () => {
    expect(scoreEntry('', 'anything')).toBe(0)
  })
})

describe('byName', () => {
  it('orders case insensitively', () => {
    const sorted = [{ name: 'Zebra' }, { name: 'apple' }].sort(byName)
    expect(sorted.map((entry) => entry.name)).toEqual(['apple', 'Zebra'])
  })

  it('groups a plugin\'s entries together by sorting on the whole name', () => {
    // The prefix is part of the name, so grouping falls out of the sort and
    // needs no grouping mechanism.
    const sorted = [
      { name: 'superpowers:brainstorming' },
      { name: 'atlassian:triage-issue' },
      { name: 'superpowers:writing-plans' },
      { name: 'atlassian:spec-to-backlog' },
    ].sort(byName)
    expect(sorted.map((entry) => entry.name)).toEqual([
      'atlassian:spec-to-backlog',
      'atlassian:triage-issue',
      'superpowers:brainstorming',
      'superpowers:writing-plans',
    ])
  })

  it('is a total order: equal lowercase names fall back to the raw name', () => {
    const sorted = [{ name: 'Ship' }, { name: 'ship' }].sort(byName)
    expect(sorted.map((entry) => entry.name)).toEqual(['Ship', 'ship'])
  })
})

describe('filterEntries', () => {
  const entries = [
    { name: 'browse' },
    { name: 'superpowers:brainstorming' },
    { name: 'gsd:stats' },
    { name: 'ship' },
  ]

  it('returns everything in name order when the query is empty', () => {
    const result = filterEntries('', entries)
    expect(result.length).toBe(4)
    expect(result.map((entry) => entry.name)).toEqual([
      'browse',
      'gsd:stats',
      'ship',
      'superpowers:brainstorming',
    ])
  })

  it('drops entries that do not match at all', () => {
    const result = filterEntries('brow', entries)
    expect(result.length).toBeGreaterThan(0)
    expect(result.map((entry) => entry.name)).toEqual(['browse'])
  })

  it('returns an empty array when nothing matches, rather than everything', () => {
    // A list this size means the user will type something that matches nothing.
    // Falling back to "show all" would be worse than showing none.
    expect(filterEntries('zzzz', entries)).toEqual([])
  })

  it('orders by score, not by name, once a query is present', () => {
    const result = filterEntries('s', entries)
    expect(result.length).toBeGreaterThan(0)
    // `ship` and `stats` start a segment; `brainstorming`'s `s` is buried.
    expect(result[0]?.name).not.toBe('superpowers:brainstorming')
  })

  it('breaks a score tie by name, so the order never depends on input order', () => {
    const tied = [{ name: 'sb' }, { name: 'sa' }]
    const result = filterEntries('s', tied)
    expect(result.length).toBe(2)
    expect(result.map((entry) => entry.name)).toEqual(['sa', 'sb'])
  })

  it('does not mutate the array it is given', () => {
    const original = [{ name: 'b' }, { name: 'a' }]
    filterEntries('', original)
    expect(original.map((entry) => entry.name)).toEqual(['b', 'a'])
  })
})

describe('rankSessions', () => {
  // `severity` is an index into the shared SEVERITY order, so lower is worse:
  // 0 is `crashed`, 1 is `waiting`.
  const sessions = [
    { name: 'alpha · aaaaaa', severity: 4 },
    { name: 'beta · bbbbbb', severity: 0 },
    { name: 'gamma · cccccc', severity: 1 },
  ]

  it('breaks a score tie by severity, worst first', () => {
    // No query, so every score is equal and severity is the only signal. The
    // crashed one is what the user opened this to find.
    const result = rankSessions('', sessions)
    expect(result.length).toBe(3)
    expect(result.map((session) => session.name)).toEqual([
      'beta · bbbbbb',
      'gamma · cccccc',
      'alpha · aaaaaa',
    ])
  })

  it('still lets a better score beat a worse state', () => {
    // Severity is a tie-break, not an override: someone who typed `alpha`
    // asked for alpha.
    const result = rankSessions('alpha', sessions)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.name).toBe('alpha · aaaaaa')
  })

  it('drops non-matches like filterEntries does', () => {
    expect(rankSessions('zzzz', sessions)).toEqual([])
  })

  it('breaks a severity tie by name, so the order never depends on input order', () => {
    const tied = [
      { name: 'b · bbbbbb', severity: 2 },
      { name: 'a · aaaaaa', severity: 2 },
    ]
    const result = rankSessions('', tied)
    expect(result.length).toBe(2)
    expect(result.map((session) => session.name)).toEqual(['a · aaaaaa', 'b · bbbbbb'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/match.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the module**

Create `src/renderer/lib/match.ts`:

```ts
/**
 * The one ranking rule in this codebase, shared by the skills panel and ⌘K.
 *
 * Two rules that drift is the failure mode this module exists to prevent, so
 * both surfaces import from here rather than sorting for themselves.
 *
 * Pure: no React, no DOM, no IPC. That is what makes it the only part of this
 * plan with unit tests, since this repo has no React rendering tests.
 */

/** Characters that begin a segment of a name: `superpowers:brainstorming`. */
const BOUNDARY = new Set([':', '-', '_', '/', '.', ' '])

const ADJACENT_BONUS = 10
const SEGMENT_BONUS = 8

/**
 * The most one query character can be charged for the distance it had to skip.
 *
 * **This cap is load-bearing and must stay below `SEGMENT_BONUS`.** Uncapped,
 * the skip cost grows with position without limit while the segment bonus is
 * fixed, so a segment start late in a long name loses to a buried match in a
 * short one: `b` in `superpowers:brainstorming` scored -4 against `b` in
 * `aaab` at -3. With the cap, a single-character boundary match scores at
 * least `SEGMENT_BONUS - MAX_GAP_PENALTY` and a buried one at most zero, so
 * the boundary always wins. Raising this to 8 or beyond reintroduces the bug.
 */
const MAX_GAP_PENALTY = 4

/**
 * How well `query` matches `name`, or null when it does not match at all.
 *
 * A subsequence match: every query character must appear in `name`, in order,
 * not necessarily adjacent. Higher is better. An empty query scores 0 and
 * matches everything, which is what lets the panel render unfiltered.
 *
 * The walk is greedy, taking the earliest candidate for each query character
 * rather than searching for the best overall alignment. That is not optimal
 * scoring, and it is deliberate: it is linear, it is deterministic, and the
 * alternative buys nothing a user of a list this size would notice.
 */
export function scoreEntry(query: string, name: string): number | null {
  const needle = query.toLowerCase()
  const haystack = name.toLowerCase()
  if (needle.length === 0) return 0

  let score = 0
  let previous = -1

  for (const character of needle) {
    const found = haystack.indexOf(character, previous + 1)
    if (found === -1) return null

    // Adjacent to the previous match: `brow` in `browse` beats `b...r...o...w`.
    if (found === previous + 1) score += ADJACENT_BONUS
    // Starts a segment, or starts the name.
    if (found === 0 || BOUNDARY.has(haystack[found - 1] ?? '')) score += SEGMENT_BONUS
    // Skipping costs, so an earlier match ranks higher, but only up to the cap:
    // see MAX_GAP_PENALTY for why an uncapped version ranked a segment start
    // below a buried match.
    score -= Math.min(found - previous - 1, MAX_GAP_PENALTY)

    previous = found
  }

  return score
}

/**
 * Name order, case insensitive, falling back to the raw name so the order is
 * total and never depends on the input order.
 *
 * Plugin entries group under their prefix as a side effect, because the prefix
 * is part of the name. That is grouping for free, with no grouping mechanism.
 */
export function byName(a: { name: string }, b: { name: string }): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/**
 * The entries matching `query`, best first.
 *
 * With no query this is every entry in name order. With a query it is only the
 * matches, ranked, ties broken by name so the result never depends on the order
 * the caller happened to hold them in. Returns a new array; the input is not
 * mutated.
 */
export function filterEntries<T extends { name: string }>(query: string, entries: T[]): T[] {
  if (query.length === 0) return [...entries].sort(byName)

  const scored: { entry: T; score: number }[] = []
  for (const entry of entries) {
    const score = scoreEntry(query, entry.name)
    if (score === null) continue
    scored.push({ entry, score })
  }

  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : byName(a.entry, b.entry)))
  return scored.map((item) => item.entry)
}

/**
 * The sessions matching `query`, best first, ties broken worst-state-first.
 *
 * `severity` is an index into `SEVERITY` from `src/shared/status.ts`, so lower
 * is worse. Severity is a tie-break rather than an override: someone who typed
 * a name asked for that name, and a crashed session does not get to jump ahead
 * of it. With no query every score is equal, so severity is what orders the
 * list, which is the case that matters: ⌘K with an empty box should put what
 * needs a human at the top.
 *
 * Separate from `filterEntries` rather than a flag on it, because only
 * sessions have a state. Both go through the same `scoreEntry`, so the two
 * lists cannot rank the same string differently.
 */
export function rankSessions<T extends { name: string; severity: number }>(
  query: string,
  sessions: T[],
): T[] {
  const scored: { session: T; score: number }[] = []
  for (const session of sessions) {
    const score = scoreEntry(query, session.name)
    if (score === null) continue
    scored.push({ session, score })
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.session.severity !== b.session.severity) return a.session.severity - b.session.severity
    return byName(a.session, b.session)
  })
  return scored.map((item) => item.session)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/match.test.ts`
Expected: PASS, 21 tests.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: A/B the three rules this module exists for**

Treat each expectation below as a claim to check, not a fact. Three of the
previous plan's A/B predictions were wrong. After each mutation, **re-read the
mutated lines and confirm the edit actually landed** before running, and record
which tests reddened **by name**. If a mutation does not redden the named test,
**stop and report BLOCKED**; never weaken a test to make it fail.

```bash
cp src/renderer/lib/match.ts /tmp/match.bak
```

Mutation A, delete the order requirement: replace
`const found = haystack.indexOf(character, previous + 1)` with
`const found = haystack.indexOf(character)`.
Run `npx vitest run tests/unit/match.test.ts`.
Expected: **two failures.** "refuses a query whose characters are in the wrong
order" is the direct one. "drops entries that do not match at all" goes with it,
because an unordered search lets `brow` match `superpowers:brainstorming`, whose
letters all appear somewhere but not in that order. Both are the same root
cause; confirm you see exactly these two.

```bash
cp /tmp/match.bak src/renderer/lib/match.ts
```

Mutation B, delete the contiguity bonus: remove the
`if (found === previous + 1) score += ADJACENT_BONUS` line.
Run the file.
Expected: **"scores a contiguous run above the same characters scattered"
fails**, because its two fixtures then score identically (-3 each) and
`toBeGreaterThan` is false on a tie. Confirm the boundary tests still pass, so
the two bonuses are shown to be independently pinned.

**This mutation is the reason that test uses a synthetic fixture.** With the
realistic pair it originally carried, this mutation reddened nothing: the cap
introduced in the previous round meant the segment bonus and gap costs alone
kept the two apart, so the adjacency bonus was doing no work the test could
see. Found by running the mutation, not by reading the code.

```bash
cp /tmp/match.bak src/renderer/lib/match.ts
```

Mutation C, make a non-match fall back to everything: in `filterEntries`, change
`if (score === null) continue` to `if (score === null) scored.push({ entry, score: -999 })`.
Run the file.
Expected: **"returns an empty array when nothing matches, rather than
everything" fails**, and "drops entries that do not match at all" fails with it.
Two failures, both about non-matches surviving.

```bash
cp /tmp/match.bak src/renderer/lib/match.ts
```

Mutation D, remove the cap that this task was blocked on: change
`score -= Math.min(found - previous - 1, MAX_GAP_PENALTY)` to
`score -= found - previous - 1`.
Run the file.
Expected: **"keeps a segment start ahead however far into the name it sits"
fails**, and "scores a segment start above a match buried mid-word" fails with
it. This is the regression test for the defect that blocked the first attempt at
this task: uncapped, the skip cost grows without limit while the segment bonus
stays fixed, so `b` in `superpowers:brainstorming` scored -4 against `b` in
`aaab` at -3.

```bash
cp /tmp/match.bak src/renderer/lib/match.ts && rm /tmp/match.bak
```

- [ ] **Step 6: Commit**

```bash
git status --short
npm run typecheck
git add src/renderer/lib/match.ts tests/unit/match.test.ts
git commit -m "Add the one matcher both skills surfaces rank with

A subsequence match with bonuses for contiguity and for starting a
segment, plus a name order that groups a plugin's entries under their
prefix without any grouping mechanism.

One module because two ranking rules that drift is the failure this is
written to prevent: the panel filter and the palette both import it.
Pure, so it is the only part of this feature with unit tests, which is
what this repo's absence of React rendering tests requires."
```

---

### Task 2: The skills panel

**Files:**
- Modify: `src/renderer/RightPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Test: covered by Task 3's E2E. There is no unit test here by design: this is
  rendered behaviour and this repo tests that end to end.

**Interfaces:**
- Consumes: `filterEntries` from `./lib/match`; `window.prcli.skills(projectCwd)`
  returning `Promise<SkillEntry[]>`; `SkillEntry` from `../shared/ipc`.
- Produces, relied on by Task 3's E2E: testids `skills-filter`,
  `skill-<name>`, `skills-empty`, `skills-loading`. `RightPanel` gains a
  required prop `onInsert: (name: string) => void`.

- [ ] **Step 1: Add the section to `RightPanel`**

Replace the whole of `src/renderer/RightPanel.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import type { ProjectDescriptor, SkillEntry, TabType } from '../shared/ipc'
import { filterEntries } from './lib/match'

export function RightPanel({
  project,
  onRun,
  onInsert,
}: {
  project: ProjectDescriptor | undefined
  onRun: (command: string, type: TabType) => void
  onInsert: (name: string) => void
}) {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const cwd = project?.cwd

  // `App` renders this component only while the panel is open, so mounting is
  // the panel opening. Re-reading on open therefore falls out of this effect
  // rather than out of a cache anyone has to remember to invalidate. Keyed on
  // `cwd` so switching project re-reads too.
  useEffect(() => {
    if (!cwd) {
      setSkills([])
      return
    }
    let cancelled = false
    setSkills(null)
    window.prcli
      .skills(cwd)
      .then((found) => {
        if (!cancelled) setSkills(found)
      })
      .catch(() => {
        // The module behind this never throws, so a rejection here means the
        // IPC round trip itself failed. An empty section is the honest render:
        // this panel is not where a transport fault gets reported.
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const matched = filterEntries(query, skills ?? [])

  return (
    <div
      data-testid="rightpanel"
      className="flex w-52 shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
    >
      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Skills
      </div>
      <input
        data-testid="skills-filter"
        // Load-bearing, not decoration. Without it ⌘W typed while filtering
        // closes a pane and destroys its tmux session. This repo has paid for
        // that once already, during a project rename.
        data-shortcuts="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter skills"
        spellCheck={false}
        className="mx-2.5 mb-1 border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
      />
      <div className="min-h-0 flex-[2] overflow-y-auto">
        {skills === null ? (
          <p data-testid="skills-loading" className="px-2.5 py-1 text-faint">
            …
          </p>
        ) : matched.length === 0 ? (
          <p data-testid="skills-empty" className="px-2.5 py-1 text-faint">
            {skills.length === 0 ? 'No skills found.' : 'Nothing matches.'}
          </p>
        ) : (
          matched.map((entry) => (
            // Keyed on source and kind as well as name. Name alone is unique
            // across today's entries, but nothing makes it so:
            // a skill directory `foo/` and a command `foo.md` both yield `foo`.
            <button
              key={`${entry.kind}:${entry.source.kind}:${entry.name}`}
              data-testid={`skill-${entry.name}`}
              disabled={!project?.available}
              onClick={() => onInsert(entry.name)}
              title={entry.description}
              className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
            >
              <span className="flex-1 truncate">{entry.name}</span>
              {/* A plugin's provenance is already in its name, so only a
                  project's own entries need a tag. Same rule as Presets. */}
              {entry.source.kind === 'repo' ? <span className="text-faint">repo</span> : null}
            </button>
          ))
        )}
      </div>

      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Presets
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Not `preset-claude`: a repository declaring a preset labelled
            `claude` would otherwise produce two elements with that testid. */}
        <button
          data-testid="preset-default-claude"
          disabled={!project || !project.available}
          onClick={() => onRun('claude', 'claude')}
          className="w-full cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
        >
          claude
        </button>
        {(project?.presets ?? []).map((preset) => (
          <button
            key={preset.id}
            data-testid={`preset-${preset.label}`}
            disabled={!project?.available}
            onClick={() => onRun(preset.command, 'preset')}
            title={preset.command}
            className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
          >
            <span className="flex-1 truncate">{preset.label}</span>
            {/* Provenance, so it is obvious which came from the repository. */}
            {preset.origin === 'repo' ? <span className="text-faint">repo</span> : null}
          </button>
        ))}
        {/* "declared": the `claude` button above is always there, so the panel
            is never actually empty. */}
        {project && project.presets.length === 0 ? (
          <p className="px-2.5 py-1 text-faint">
            No declared presets. Add a .prcli.json to the repository.
          </p>
        ) : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire `onInsert` in `App`**

In `src/renderer/App.tsx`, find the `RightPanel` render at roughly line 837:

```tsx
        {panelOpen ? (
          <RightPanel project={project} onRun={(command, type) => launch(command, type)} />
        ) : null}
```

Replace it with:

```tsx
        {panelOpen ? (
          <RightPanel
            project={project}
            onRun={(command, type) => launch(command, type)}
            // No trailing `\r`: this types the invocation and leaves the user
            // to decide, per the spec. A submitted `/name` would run a skill
            // nobody had finished choosing.
            onInsert={(name) => {
              if (activePaneId) window.prcli.input(activePaneId, `/${name}`)
            }}
          />
        ) : null}
```

`activePaneId` is already in scope at that point; it is the same value the ⌘W
branch of the keydown handler uses.

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
```

Expected: clean. If it reports that `RightPanel` is missing `onInsert` at another
call site, there is a second render of it that this step did not know about:
stop and report that rather than guessing at a value for it.

```bash
git status --short
git add src/renderer/RightPanel.tsx src/renderer/App.tsx
git commit -m "Put the project's skills in the right panel, above Presets

161 entries in a 208px column, so the section leads with a filter and
ranks through the shared matcher rather than listing in scan order.

Clicking types /name into the active pane with no trailing carriage
return, which leaves the choice with the user. The filter input carries
data-shortcuts=off, without which typing in it leaves Command-W live and
Command-W destroys a pane's tmux session."
```

---

### Task 3: The panel's E2E

**Files:**
- Create: `tests/e2e/skills.spec.ts`

**Interfaces:**
- Consumes: `launchApp`, `killServer` from `./harness`; the testids Task 2
  produced.
- Produces: the fixture layout Task 5 reuses.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/skills.spec.ts`:

```ts
/**
 * The skills panel and the ⌘K palette, against a fixture `~/.claude` rather
 * than whatever is installed on the machine that day.
 *
 * `PRCLI_CLAUDE_HOME` is a required launch option, so this spec points the app
 * at a temp tree holding four known entries and asserts against a known list.
 * That is what makes "the panel shows the right names" a real assertion here
 * rather than a restatement of the developer's own plugin set.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-skills'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string

const write = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-skills-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-skills-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-skills-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-skills-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-skills-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })

  // No enabled plugins: this spec is about the surfaces, and a plugin fixture
  // would add a registry file without adding an assertion.
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  // Two user skills, one user command, one repo command. `zebra` exists so the
  // filter has something to exclude, and the repo entry so the `repo` tag has
  // a subject.
  await write(join(claudeHome, 'skills', 'browse', 'SKILL.md'), '---\ndescription: Fast browser.\n---\n')
  await write(join(claudeHome, 'skills', 'zebra', 'SKILL.md'), '---\ndescription: Last one.\n---\n')
  await write(join(claudeHome, 'commands', 'gsd', 'stats.md'), '---\ndescription: Show stats.\n---\n')
  await write(join(projectCwd, '.claude', 'commands', 'shipit.md'), '---\ndescription: Ship it.\n---\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'p1', name: 'demo', cwd: projectCwd, presets: [] }],
      tabs: [],
      activeProjectId: 'p1',
      activeTabId: null,
    }),
  )

  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the panel lists the project\'s skills and commands in name order', async () => {
  const rows = page.locator('[data-testid^="skill-"]')
  await expect(rows).toHaveCount(4)
  // Non-empty asserted by the count above, before anything reads the contents.
  expect(await rows.allInnerTexts()).toEqual(['browse', 'gsd:stats', 'shipit', 'zebra'])
})

test('a project\'s own command is tagged repo and the others are not', async () => {
  await expect(page.getByTestId('skill-shipit')).toContainText('repo')
  await expect(page.getByTestId('skill-browse')).not.toContainText('repo')
})

test('the filter narrows to matches and says so when nothing matches', async () => {
  const filter = page.getByTestId('skills-filter')
  await filter.fill('brow')
  const rows = page.locator('[data-testid^="skill-"]')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('skill-browse')).toBeVisible()

  await filter.fill('qqqq')
  await expect(page.getByTestId('skills-empty')).toContainText('Nothing matches')
  await expect(rows).toHaveCount(0)

  await filter.fill('')
  await expect(rows).toHaveCount(4)
})

test('clicking a skill types its invocation and does NOT submit it', async () => {
  // A negative claim. `expect.poll` and `toHaveCount` return on their first
  // match and cannot express "and then nothing else happened", so this settles
  // first and reads the pane afterwards.
  await page.getByTestId('preset-default-claude').click()
  const pane = page.getByTestId('terminal').first()
  await expect(pane).toBeVisible()

  await page.getByTestId('skills-filter').fill('brow')
  await page.getByTestId('skill-browse').click()

  // Let anything that was going to happen happen.
  await page.waitForTimeout(750)

  const text = await page.locator('.xterm-rows').first().innerText()
  expect(text).toContain('/browse')
  // If it had submitted, the shell would have answered. This is the assertion
  // the settle above exists for.
  expect(text).not.toContain('command not found')
})
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/skills.spec.ts`
Expected: PASS, 4 tests.

If `electronApplication.firstWindow: Timeout` appears, that is macOS AppKit's
crash-restore alert blocking `applicationDidFinishLaunching`, not this code.
Re-run once. **Never raise the timeout**: the stall only ends when Playwright
tears the process down, so a longer timeout makes it worse.

- [ ] **Step 3: A/B that this spec can fail**

```bash
cp src/renderer/RightPanel.tsx /tmp/panel.bak
```

Mutation A, in `RightPanel`, replace `filterEntries(query, skills ?? [])` with
`(skills ?? [])`.
Run the spec.
Expected: **"the filter narrows to matches and says so when nothing matches"
fails**, and "lists the project's skills and commands in name order" fails with
it, because scan order is not name order.

```bash
cp /tmp/panel.bak src/renderer/RightPanel.tsx
```

Mutation B, change `` onInsert(entry.name) `` to `` onInsert(`${entry.name}\r`) ``.
Run the spec.
Expected: **"clicking a skill types its invocation and does NOT submit it"
fails.** This is the mutation that matters: it proves the negative claim is
actually pinned rather than passing because nothing was checked.

```bash
cp /tmp/panel.bak src/renderer/RightPanel.tsx && rm /tmp/panel.bak
```

Record which tests reddened by name for both mutations, and confirm each
mutation was present in the file before running.

- [ ] **Step 4: Commit**

```bash
git status --short
git add tests/e2e/skills.spec.ts
git commit -m "Witness the skills panel against a fixture Claude home

Four known entries in a temp tree rather than whatever the developer has
installed, so the name-order assertion is a real one.

The no-submit test settles before reading the pane: expect.poll and
toHaveCount return on their first match and cannot assert that a thing
did not happen, which has already produced one false pass here."
```

---

### Task 4: The palette

**Files:**
- Create: `src/renderer/lib/tabLabel.ts`
- Modify: `src/renderer/TabBar.tsx`, `src/renderer/DeadPane.tsx`
- Create: `src/renderer/CommandPalette.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `filterEntries` from `./lib/match`; `Dialog`, `DialogContent`,
  `DialogTitle` from `./ui/Dialog`; `window.prcli.skills`.
- Produces, relied on by Task 5: `tabLabel(tab: TabDescriptor): string`, and
  testids `command-palette`, `palette-input`, `palette-session-<id>`,
  `palette-action-<name>`, `palette-empty`.

- [ ] **Step 1: Extract the tab label, rather than writing a third copy of it**

`TabBar.tsx:6` and `DeadPane.tsx:5` each hold a private `label` with an
identical body. The palette needs the same string, so that the row a user picks
reads the way the tab they are looking for reads. Extract it before adding a
third copy.

Create `src/renderer/lib/tabLabel.ts`:

```ts
import type { TabDescriptor } from '../../shared/ipc'

/**
 * How a tab is named wherever the user is asked to pick one: the tab bar, a
 * dead pane's chrome, and the ⌘K palette.
 *
 * Shared rather than repeated, so the palette cannot drift into naming a tab
 * differently from the bar the user is reading it off. There is no title field
 * on a tab; the slug and a short id are what identify one.
 */
export function tabLabel(tab: TabDescriptor): string {
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}
```

In `src/renderer/TabBar.tsx`, delete the local `label` function at lines 6-8 and
import the shared one instead:

```ts
import { tabLabel } from './lib/tabLabel'
```

Then change the single call site from `{label(tab)}` to `{tabLabel(tab)}`.

In `src/renderer/DeadPane.tsx`, delete the local `label` function at lines 5-7,
add the same import, and change its call site from `label(pane)` to
`tabLabel(pane)`. Its parameter is named `pane` and is a `TabDescriptor`, which
is the same type; do not rename anything else.

Run `npm run typecheck`. Expected: clean. Run `npx playwright test tests/e2e/tabs.spec.ts`.
Expected: PASS, unchanged. This step must not alter a single rendered string, so
if any tab-bar assertion moves, stop and report rather than adjusting the test.

- [ ] **Step 2: Write the component**

Create `src/renderer/CommandPalette.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { SkillEntry } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { filterEntries, rankSessions } from './lib/match'

/** One switchable pane, flattened by `App` so this component holds no state. */
export interface PaletteSession {
  id: string
  /** As the tab bar names it, which is also what the query matches against. */
  name: string
  /** Index into `SEVERITY`, so lower is worse. The tie-break for equal scores. */
  severity: number
}

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  projectCwd,
  onSelectSession,
  onInsert,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: PaletteSession[]
  projectCwd: string | undefined
  onSelectSession: (id: string) => void
  onInsert: (name: string) => void
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [query, setQuery] = useState('')

  // Fetched on open, like AddProjectDialog rescans on open: a skill written a
  // minute ago should be here.
  useEffect(() => {
    if (!open || !projectCwd) return
    let cancelled = false
    setQuery('')
    window.prcli
      .skills(projectCwd)
      .then((found) => {
        if (!cancelled) setSkills(found)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [open, projectCwd])

  const matchedSessions = rankSessions(query, sessions)
  // Empty query shows sessions only. Every action ahead of the dozen things
  // the user switches between would bury the switcher this app is about.
  const matchedActions = query.length === 0 ? [] : filterEntries(query, skills)

  const choose = (run: () => void): void => {
    run()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="command-palette">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-faint">
          Go to
        </DialogTitle>
        <input
          data-testid="palette-input"
          // Same reason as the panel's filter: without this, ⌘W typed here
          // closes a pane and destroys its session.
          data-shortcuts="off"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions, then skills"
          spellCheck={false}
          className="mb-2 w-full border border-border bg-transparent px-2 py-1 text-[12px] text-fg placeholder:text-faint focus:outline-none"
        />
        <div className="max-h-72 overflow-y-auto text-[11px]">
          {matchedSessions.map((session) => (
            <button
              key={session.id}
              data-testid={`palette-session-${session.id}`}
              onClick={() => choose(() => onSelectSession(session.id))}
              className="flex w-full cursor-default border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
            >
              <span className="flex-1 truncate">{session.name}</span>
            </button>
          ))}
          {matchedActions.map((entry) => (
            // Composite key for the same reason the panel uses one: `name` is
            // unique across today's entries but nothing guarantees it.
            <button
              key={`${entry.kind}:${entry.source.kind}:${entry.name}`}
              data-testid={`palette-action-${entry.name}`}
              onClick={() => choose(() => onInsert(entry.name))}
              title={entry.description}
              className="flex w-full cursor-default border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
            >
              <span className="flex-1 truncate">/{entry.name}</span>
            </button>
          ))}
          {matchedSessions.length === 0 && matchedActions.length === 0 ? (
            <p data-testid="palette-empty" className="px-1 py-2 text-faint">
              Nothing matches.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

Sessions are listed before actions by construction: they are rendered in a
separate pass above them, so no comparator has to encode "sessions always win"
and no ranking change can ever reorder the two groups relative to each other.

- [ ] **Step 3: Bind ⌘K and mount it in `App`**

In `src/renderer/App.tsx`, add the import beside the other component imports at
the top:

```tsx
import { CommandPalette, type PaletteSession } from './CommandPalette'
```

Add the state beside `panelOpen` (roughly line 57):

```tsx
  const [paletteOpen, setPaletteOpen] = useState(false)
```

In the keydown handler, immediately after the `KeyD` branch that ends at roughly
line 562, add:

```tsx
      // Below the `data-shortcuts="off"` guard at the top of this handler, so
      // it inherits that protection: ⌘K typed into the palette's own input is
      // the palette's, not a request to reopen it.
      if (event.code === 'KeyK' && !event.altKey) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
```

Mount it beside `AddProjectDialog` and `SettingsPane` at roughly line 841:

```tsx
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          sessions={paletteSessions}
          projectCwd={project?.cwd}
          onSelectSession={(id) => {
            const tab = state.panes.find((candidate) => candidate.id === id)
            if (!tab) return
            // The same two dispatches `onSelectNeedy` runs, in the same order.
            dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
            dispatch({ type: 'activatedTab', id: tab.id })
          }}
          onInsert={(name) => {
            if (activePaneId) window.prcli.input(activePaneId, `/${name}`)
          }}
        />
```

And build `paletteSessions` just above the `return`, beside the other derived
values, importing `tabLabel` from `./lib/tabLabel` at the top:

```tsx
  // One row per PANE, not per tab, per the spec: a split tab holds two
  // sessions and both are switchable. `state.panes` is the same collection
  // `needsYou` ranks, so this list and Needs You cannot disagree about what a
  // session is.
  //
  // `severity` is the index into the shared SEVERITY order, so lower is worse.
  // An unreported pane sorts last rather than first, which is why the fallback
  // is the array length and not zero.
  const paletteSessions: PaletteSession[] = state.panes.map((pane) => {
    const reported = state.status[pane.id]
    return {
      id: pane.id,
      name: tabLabel(pane),
      severity: reported ? SEVERITY.indexOf(reported) : SEVERITY.length,
    }
  })
```

Import `SEVERITY` at the top of `App.tsx`:

```tsx
import { SEVERITY } from '../shared/status'
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/renderer/lib/tabLabel.ts src/renderer/TabBar.tsx src/renderer/DeadPane.tsx src/renderer/CommandPalette.tsx src/renderer/App.tsx
git commit -m "Add the Command-K palette: sessions first, skills once you type

Sessions render in their own pass above actions, so no comparator has to
encode "sessions win" and no future ranking change can reorder the two
groups against each other.

An empty query shows sessions only. Putting 161 actions ahead of the
dozen things the user switches between would bury the switcher this app
exists for.

The input carries data-shortcuts=off, so Command-W typed into it does
not close a pane and destroy its session."
```

---

### Task 5: The palette's E2E

**Files:**
- Modify: `tests/e2e/skills.spec.ts`

**Interfaces:**
- Consumes: the testids Task 4 produced, and the fixture Task 3 built.

- [ ] **Step 1: Add the tests**

Append to `tests/e2e/skills.spec.ts`, inside the same file so the fixture is
shared:

```ts
test('⌘K opens the palette while a terminal has focus, and Escape closes it', async () => {
  // "It should be free, ⌘T and ⌘W already work through the same listener" is
  // an argument, and three dead tests in Plan 1 came from arguments. This is
  // the test instead.
  await page.getByTestId('terminal').first().click()
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toBeHidden()
})

test('an empty query lists sessions and no actions', async () => {
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  const sessions = page.locator('[data-testid^="palette-session-"]')
  await expect(sessions).not.toHaveCount(0)
  // Settle, then assert the absence: a count of zero is the claim, and
  // toHaveCount would return on its first match if any appeared later.
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid^="palette-action-"]').count()).toBe(0)

  await page.keyboard.press('Escape')
})

test('typing brings skills in below the sessions', async () => {
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('brow')
  const action = page.getByTestId('palette-action-browse')
  await expect(action).toBeVisible()
  await expect(action).toContainText('/browse')

  await page.keyboard.press('Escape')
})

test('choosing a skill from the palette types it and closes the palette', async () => {
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('brow')
  await page.getByTestId('palette-action-browse').click()
  await expect(page.getByTestId('command-palette')).toBeHidden()

  await page.waitForTimeout(750)
  const text = await page.locator('.xterm-rows').first().innerText()
  expect(text).toContain('/browse')
})
```

- [ ] **Step 2: Run the whole spec**

Run: `npx playwright test tests/e2e/skills.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: A/B the two rules the palette exists for**

```bash
cp src/renderer/CommandPalette.tsx /tmp/palette.bak
```

Mutation A, show actions unconditionally: replace
`query.length === 0 ? [] : filterEntries(query, skills)` with
`filterEntries(query, skills)`.
Run the spec.
Expected: **"an empty query lists sessions and no actions" fails.**

```bash
cp /tmp/palette.bak src/renderer/CommandPalette.tsx
```

Mutation B, drop the shortcut guard: remove `data-shortcuts="off"` from
`palette-input`.
Run the spec.
Expected: this is the mutation to be honest about. **If no test reddens, say
so and report it rather than inventing one.** The attribute's effect is that ⌘W
typed into the palette does not close a pane; no test above types ⌘W into the
palette. If it does not redden, add this test, then re-run the mutation and
confirm it now does:

```ts
test('⌘W typed into the palette does not destroy a pane', async () => {
  const before = await page.locator('[data-testid^="tab-"]').count()
  expect(before).toBeGreaterThan(0)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').click()
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  expect(await page.locator('[data-testid^="tab-"]').count()).toBe(before)
})
```

```bash
cp /tmp/palette.bak src/renderer/CommandPalette.tsx && rm /tmp/palette.bak
```

- [ ] **Step 4: Full gates and commit**

**Check with the human partner before running the suites.** A second session may
be working in this checkout, and two suites at once changes the results rather
than merely slowing them down.

```bash
git status --short
npm run typecheck
npm run check-deps
npm test
npm run e2e
ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /zsh$/' | wc -l
```

Expected: typecheck and check-deps clean; `npm test` green with 21 more tests
than the 1158 baseline; E2E green with 8 more than the 44 baseline.

Before believing any integration failure is a defect, check for
`error connecting to /private/tmp/tmux-501/prcli-test (No such file or
directory)`. That is a known intermittent: the shared test tmux server exits
when its last session is killed, so a concurrent file's `kill-session` finds no
socket. Re-run once. Also count `posix_spawnp failed`, `Device not configured`
and `fork failed`, inside assertion text as well as error lines. 91 orphan
shells is what starves this machine.

```bash
git add tests/e2e/skills.spec.ts
git commit -m "Witness the palette: Command-K over a terminal, sessions, and typing

Command-K while a terminal holds focus gets a test rather than the
argument that it should be free, because that argument produced three
tests that could not fail in Plan 1.

The empty-query claim is that actions are absent, so it settles and then
counts, instead of asking a matcher that returns on its first match."
```

---

## Done when

- One matcher module ranks both surfaces, both lists reach `scoreEntry` through
  it, sessions tie-break worst-state-first through the shared `SEVERITY` order,
  and its three A/B mutations each redden the intended test.
- The panel lists every entry in name order, filters through that matcher, tags
  only a project's own entries `repo`, and types `/name` with no trailing
  carriage return.
- ⌘K opens over a focused terminal, shows sessions on an empty query, brings
  actions in on typing, and closes on Escape and on choosing.
- Both new inputs carry `data-shortcuts="off"`.
- Typecheck, check-deps, the full suite and E2E are green, tree clean.

## Deliberately not in this plan

Recency or frecency in ranking. Deduplication of entry names: no collision
exists among the 161 entries measured today, and the composite React keys mean
one appearing later renders two honest rows rather than breaking. Duplicate and
Detach-to-tab. Everything in Plan 3 (context menu, tab names, config v6, drag
reorder, onboarding screen) and Plan 4 (the tab-bar collapse).

## Open, and not this plan's to answer

`SkillEntry.name` is not unique by construction, and `src/shared/ipc.ts` no
longer says anything about uniqueness after Plan 1b removed a claim that had
become false. A skill directory `foo/` and a command `foo.md` both emit `foo`.
Zero collisions today. This plan is safe either way because it keys on a
composite, but whether the type should carry a truthful caveat is a decision for
the human partner, and it collides with Plan 1b's own "Done when".
