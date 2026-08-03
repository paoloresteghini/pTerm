# M4 Plan 1 — Skill Resolution Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the main process one read-only, never-throwing way to answer
"which skills and commands exist for this project", resolving plugin scope
correctly, and expose it on one IPC channel.

**Architecture:** A new `src/main/skills/` module, splitting pure logic from
filesystem access the way `notify/rules.ts` and `tmux/resolve.ts` already do.
`frontmatter.ts` and `resolve.ts` are pure and carry every rule that can be
wrong; `scan.ts` does the reading and is the only part that touches disk. One
`ipcMain.handle` in `register.ts`, one method on `PrcliApi`. No UI in this
plan — the panel and the palette that consume this are Plan 2.

**Tech Stack:** TypeScript, Node `fs/promises`, Electron IPC, vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-prcli-m4-design.md`, "Plan 1 — the
resolution layer" and "Testing and safety".

## Global Constraints

- **No new dependencies.** `npm install` / `npm ci` must not be run: it breaks
  node-pty's spawn-helper permissions and fails every integration test until
  the postinstall repairs it. There is no YAML parser in this repo and none is
  to be added — frontmatter is hand-rolled in Task 1.
- **Nothing in this plan writes to `~/.claude`.** Every path here is read-only.
  The only code in this repo permitted to write `~/.claude/settings.json` is
  `src/main/hooks/install.ts`, through its backed-up idempotent merge.
- **Nothing here throws.** A damaged `settings.json`, an
  `installed_plugins.json` whose shape changed under a Claude Code update, an
  unreadable directory or a malformed skill file contributes nothing. Same rule
  and same reason as `src/main/projects/manifest.ts`.
- Node built-ins are imported with the `node:` prefix, matching every existing
  file.
- `npm run typecheck` must stay clean; the repo is on TypeScript 7.0.2 with
  strict settings.
- Tests are vitest. Pure tests go in `tests/unit/`, anything touching disk in
  `tests/integration/`. `vitest.config.mts` runs `environment: 'node'` — there
  is no DOM.
- **Assert the observable, not the mechanism.** House style, learned last
  round: "the entry for `browse` appears with its description" survives a
  refactor; "`frontmatter()` was called twice" does not.
- **A/B every load-bearing assertion, including new ones.** Twenty tests in
  this repo have been found incapable of failing. Confirm the mutation landed
  and that the test which went red is the one intended.
- Restore an A/B by snapshot copy (`cp file file.bak` … `cp file.bak file`).
  **Never `git checkout -- <file>`** — that has wiped an uncommitted fix twice
  on this project.
- Before believing any integration failure is a defect, count `posix_spawnp
  failed`, `Device not configured` and `fork failed` — inside assertion text as
  well as error lines. Check orphan shells with
  `ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /zsh$/' | wc -l`.

## Facts measured off the target machine on 2026-08-03

These are load-bearing. Each was read off disk, not assumed.

- `enabledPlugins` in `~/.claude/settings.json` is a `{name: boolean}` map with
  22 entries, and some values are `false` (e.g.
  `security-guidance@claude-plugins-official`). Enabled means `=== true`.
- `~/.claude/plugins/installed_plugins.json` is `version: 2` and maps
  `plugin@marketplace` to an **array** of installs, each with `scope`
  (`user` | `project`), `projectPath` when project-scoped, `installPath`, and
  `version`. 23 plugins, 25 installs, 22 user-scope, 3 project-scope.
- Exactly two plugins have more than one install: `superpowers` (6.1.1 scoped
  to `/Users/paolo/Code/Lumio`, 6.2.0 user-wide) and
  `solutions-architect-skills`.
- 13 of the 25 `installPath`s contain a `skills/` directory. A missing one is
  normal.
- 73 skills in `~/.claude/skills`. Descriptions: 57 plain, 14 quoted, **2
  folded block scalars (`>`)** — `brand-voice-enforcement` and
  `ogilvy-copywriting`. All 73 have a `name:`.
- 36 files under `~/.claude/commands`, all carrying an already-namespaced
  `name:` in frontmatter (e.g. `gsd:autonomous`). **Exactly one has no
  `name:`** — `gsd/reapply-patches.md`.
- Stale plugin versions coexist on disk (`supabase` 0.1.11, 0.1.12, 0.1.13),
  and `plugins/marketplaces/caveman/.cursor/skills` and `.windsurf/skills`
  exist and belong to other tools. **Both are excluded by construction** —
  scanning resolves *from* the `installPath` the registry names, so neither is
  ever a candidate. Do not write a filter for them; a filter would imply the
  scan could otherwise reach them, and a comment asserting a mechanism that is
  not true is a defect in this repo.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/main/skills/frontmatter.ts` | Parse the two scalar fields out of a skill/command file's YAML frontmatter. Pure. No I/O. |
| Create `src/main/skills/resolve.ts` | Decide which plugin install applies to a project, and therefore which directories to scan. Pure. No I/O. |
| Create `src/main/skills/scan.ts` | Read the directories, build `SkillEntry[]`. The only file here that touches disk. |
| Modify `src/shared/ipc.ts` | `SkillEntry`, `CHANNELS.skills`, `PrcliApi.skills`. |
| Modify `src/main/ipc/register.ts` | One `ipcMain.handle`. |
| Modify `src/preload/index.ts` | One line on the bridge. |
| Modify `tests/e2e/harness.ts` | Sixth required launch option, `PRCLI_CLAUDE_HOME`. |
| Modify `tests/unit/e2eSafety.test.ts` | Enumerate the sixth option. |
| Create `tests/unit/frontmatter.test.ts` | Task 1. |
| Create `tests/unit/skillResolve.test.ts` | Task 2. |
| Create `tests/integration/skills.test.ts` | Tasks 3 and 4. |

---

### Task 1: The frontmatter parser

**Files:**
- Create: `src/main/skills/frontmatter.ts`
- Test: `tests/unit/frontmatter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `frontmatter(text: string): Record<string, string>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/frontmatter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { frontmatter } from '../../src/main/skills/frontmatter'

/**
 * The four shapes that actually occur, counted across the 73 skills and 36
 * commands on the target machine rather than imagined: 57 plain values, 14
 * quoted, 2 folded block scalars, and one file with no `name:` at all.
 */
describe('frontmatter', () => {
  it('reads a plain scalar', () => {
    const fields = frontmatter('---\nname: browse\ndescription: Fast browser.\n---\nbody')
    expect(fields.name).toBe('browse')
    expect(fields.description).toBe('Fast browser.')
  })

  it('strips matching quotes', () => {
    const fields = frontmatter('---\nname: "a"\ndescription: \'b\'\n---\n')
    expect(fields.name).toBe('a')
    expect(fields.description).toBe('b')
  })

  it('folds a block scalar onto one line', () => {
    // The shape `brand-voice-enforcement` and `ogilvy-copywriting` use. A
    // parser that only reads the value on the key's own line reports these
    // two as having no description at all.
    const text = '---\nname: ogilvy\ndescription: >\n  First part\n  second part\nother: x\n---\n'
    expect(frontmatter(text).description).toBe('First part second part')
  })

  it('keeps reading keys after a block scalar', () => {
    const text = '---\ndescription: |\n  folded\nname: kept\n---\n'
    expect(frontmatter(text).name).toBe('kept')
  })

  it('returns nothing for a file with no frontmatter', () => {
    expect(frontmatter('# Just a heading\n')).toEqual({})
  })

  it('returns nothing when the frontmatter is never closed', () => {
    expect(frontmatter('---\nname: unterminated\n')).toEqual({})
  })

  it('ignores nested keys rather than flattening them', () => {
    // `allowed-tools:` with an indented list under it is common. An indented
    // line must never be mistaken for a top-level field.
    const text = '---\nname: n\nallowed-tools:\n  - Read\n  - Write\n---\n'
    expect(frontmatter(text)).toEqual({ name: 'n', 'allowed-tools': '' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/frontmatter.test.ts`
Expected: FAIL — cannot resolve `../../src/main/skills/frontmatter`.

- [ ] **Step 3: Write the implementation**

Create `src/main/skills/frontmatter.ts`:

```ts
/**
 * The scalar fields a skill or command file declares about itself.
 *
 * Deliberately not a YAML parser, and not a step towards one. This repo has
 * nine runtime dependencies and `npm install` is not run casually here — it
 * breaks node-pty's spawn-helper permissions and fails every integration test
 * until the postinstall repairs it. So this reads what the panel needs and
 * ignores the rest.
 *
 * The shapes handled were counted, not guessed, across the 73 skills and 36
 * commands on the target machine: 57 plain values, 14 quoted, 2 folded block
 * scalars (`brand-voice-enforcement` and `ogilvy-copywriting`), and one
 * command file carrying no `name:` at all. Anything else contributes nothing
 * rather than throwing — see the module rule in `scan.ts`.
 */
export function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const lines = text.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  // An unterminated block is not frontmatter. Reading to end-of-file instead
  // would treat a document that merely opens with a rule as a field list.
  if (end === -1) return {}

  const fields: Record<string, string> = {}
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? ''
    // Top-level keys only. An indented line is either a block scalar's
    // continuation — consumed below, and skipped here on the way back past it
    // — or a nested structure this does not read.
    if (/^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()

    if (raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const folded: string[] = []
      for (let j = i + 1; j < end; j += 1) {
        const next = lines[j] ?? ''
        // A blank line belongs to the block; an unindented one ends it.
        if (next.trim() !== '' && !/^\s/.test(next)) break
        folded.push(next.trim())
      }
      fields[key] = folded.join(' ').trim()
      continue
    }

    fields[key] = unquote(raw)
  }
  return fields
}

/** Strips one matching pair of surrounding quotes, and only a matching pair. */
function unquote(value: string): string {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1)
  }
  return value
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/frontmatter.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: A/B the two assertions that carry weight**

Both mutations are made against the real file, run, then restored by snapshot
copy — never `git checkout`.

```bash
cp src/main/skills/frontmatter.ts /tmp/fm.bak
```

Mutation A — delete the block-scalar branch (replace the whole
`if (raw === '>' ...) { ... }` block with nothing). Run
`npx vitest run tests/unit/frontmatter.test.ts`.
Expected: **"folds a block scalar onto one line" fails**, and it is the only
description test that does. Confirm the failure names that test.

```bash
cp /tmp/fm.bak src/main/skills/frontmatter.ts
```

Mutation B — change `if (/^\s/.test(line)) continue` to `if (false) continue`.
Run the same file.
Expected: **"ignores nested keys rather than flattening them" fails.** If it
passes, the test is not pinning what it claims and must be strengthened before
moving on.

```bash
cp /tmp/fm.bak src/main/skills/frontmatter.ts && rm /tmp/fm.bak
```

- [ ] **Step 6: Verify the tree is clean and commit**

```bash
git status --short   # must show only the two new files
git add src/main/skills/frontmatter.ts tests/unit/frontmatter.test.ts
git commit -m "Read a skill file's own two fields, without adding a YAML parser"
```

---

### Task 2: Plugin scope resolution

**Files:**
- Create: `src/main/skills/resolve.ts`
- Test: `tests/unit/skillResolve.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface SkillSource { dir: string; source: SkillOrigin }`
  - `pluginSkillDirs(enabled: unknown, registry: unknown, projectCwd: string): SkillSource[]`
  - `SkillOrigin` is imported from `src/shared/ipc.ts` and is defined in
    Task 3. **To keep this task self-contained, Task 2 defines `SkillOrigin`
    locally in `resolve.ts` and Task 3 moves it to `src/shared/ipc.ts` and
    re-imports it here.** That move is an explicit step in Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/skillResolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pluginSkillDirs } from '../../src/main/skills/resolve'

const LUMIO = '/Users/paolo/Code/Lumio'
const OTHER = '/Users/paolo/Code/PRCLI'

/** The real registry's shape, reduced to the one plugin that has two installs. */
const registry = {
  version: 2,
  plugins: {
    'superpowers@claude-plugins-official': [
      { scope: 'project', projectPath: LUMIO, installPath: '/cache/superpowers/6.1.1' },
      { scope: 'user', installPath: '/cache/superpowers/6.2.0' },
    ],
    'frontend-design@claude-plugins-official': [
      { scope: 'user', installPath: '/cache/frontend-design/unknown' },
    ],
    'security-guidance@claude-plugins-official': [
      { scope: 'user', installPath: '/cache/security-guidance/1.0.0' },
    ],
  },
}

const enabled = {
  'superpowers@claude-plugins-official': true,
  'frontend-design@claude-plugins-official': true,
  // Really present and really false on the target machine. This is the case
  // a key-presence check gets wrong.
  'security-guidance@claude-plugins-official': false,
}

describe('pluginSkillDirs', () => {
  it('takes the project-scoped install when the project matches', () => {
    const dirs = pluginSkillDirs(enabled, registry, LUMIO)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.map((entry) => entry.dir)).toContain('/cache/superpowers/6.1.1/skills')
    expect(dirs.map((entry) => entry.dir)).not.toContain('/cache/superpowers/6.2.0/skills')
  })

  it('falls back to the user-scoped install for any other project', () => {
    const dirs = pluginSkillDirs(enabled, registry, OTHER)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.map((entry) => entry.dir)).toContain('/cache/superpowers/6.2.0/skills')
    expect(dirs.map((entry) => entry.dir)).not.toContain('/cache/superpowers/6.1.1/skills')
  })

  it('omits a plugin whose flag is false rather than merely absent', () => {
    const dirs = pluginSkillDirs(enabled, registry, OTHER)
    expect(dirs.length).toBeGreaterThan(0)
    for (const entry of dirs) {
      expect(entry.dir).not.toContain('security-guidance')
    }
  })

  it('names the plugin without its marketplace suffix', () => {
    const dirs = pluginSkillDirs(enabled, registry, OTHER)
    const found = dirs.find((entry) => entry.dir.includes('frontend-design'))
    expect(found).toBeDefined()
    expect(found?.source).toEqual({ kind: 'plugin', plugin: 'frontend-design' })
  })

  it('omits an enabled plugin the registry does not list', () => {
    const dirs = pluginSkillDirs({ 'ghost@nowhere': true }, registry, OTHER)
    expect(dirs).toEqual([])
  })

  it('omits a plugin with no install this project can use', () => {
    const onlyOtherProject = {
      version: 2,
      plugins: {
        'scoped@m': [{ scope: 'project', projectPath: LUMIO, installPath: '/cache/scoped' }],
      },
    }
    expect(pluginSkillDirs({ 'scoped@m': true }, onlyOtherProject, OTHER)).toEqual([])
  })

  it('contributes nothing when either input is the wrong shape', () => {
    expect(pluginSkillDirs(null, registry, OTHER)).toEqual([])
    expect(pluginSkillDirs(enabled, 'not an object', OTHER)).toEqual([])
    expect(pluginSkillDirs(enabled, { plugins: 'wrong' }, OTHER)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/skillResolve.test.ts`
Expected: FAIL — cannot resolve `../../src/main/skills/resolve`.

- [ ] **Step 3: Write the implementation**

Create `src/main/skills/resolve.ts`:

```ts
import { join } from 'node:path'

/**
 * Where an entry came from. Moved to `src/shared/ipc.ts` in Task 3, once the
 * renderer needs to draw it; defined here first so this module and its tests
 * stand alone.
 */
export type SkillOrigin = { kind: 'user' } | { kind: 'repo' } | { kind: 'plugin'; plugin: string }

export interface SkillSource {
  dir: string
  source: SkillOrigin
}

interface Install {
  scope: string
  projectPath?: string
  installPath: string
}

/**
 * The `skills/` directories the enabled plugins contribute to one project.
 *
 * Pure: it is handed the two parsed files rather than reading them, for the
 * same reason `notify/rules.ts` is handed its own clock — every rule that can
 * be wrong is then testable with no disk.
 *
 * Stale cached versions and the `.cursor/skills` and `.windsurf/skills`
 * directories that other tools leave under `plugins/marketplaces/` are
 * excluded **by construction**: this only ever builds a path from an
 * `installPath` the registry names, and none of those is one. There is
 * deliberately no filter for them.
 */
export function pluginSkillDirs(
  enabled: unknown,
  registry: unknown,
  projectCwd: string,
): SkillSource[] {
  const flags = asRecord(enabled)
  const plugins = asRecord(asRecord(registry).plugins)
  const dirs: SkillSource[] = []

  for (const [key, value] of Object.entries(flags)) {
    // `=== true`, not truthiness and not key-presence: this map carries
    // explicit `false` entries for plugins the user has turned off, and a
    // presence check would enable every one of them.
    if (value !== true) continue
    const installs = plugins[key]
    if (!Array.isArray(installs)) continue
    const install = pick(installs, projectCwd)
    if (!install) continue
    dirs.push({
      dir: join(install.installPath, 'skills'),
      source: { kind: 'plugin', plugin: key.split('@')[0] ?? key },
    })
  }
  return dirs
}

/**
 * A project-scoped install for exactly this project beats the user-scoped one;
 * with neither, the plugin contributes nothing.
 *
 * Only two plugins on the target machine have more than one install, so this
 * rule is narrow — but it is the difference between showing a project the
 * skills Claude is actually running in it and showing it a different version's.
 */
function pick(installs: unknown[], projectCwd: string): Install | null {
  const valid = installs.filter(isInstall)
  const scoped = valid.find(
    (install) => install.scope === 'project' && install.projectPath === projectCwd,
  )
  if (scoped) return scoped
  return valid.find((install) => install.scope === 'user') ?? null
}

function isInstall(value: unknown): value is Install {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { scope?: unknown; installPath?: unknown }
  return typeof candidate.scope === 'string' && typeof candidate.installPath === 'string'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/skillResolve.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: A/B the two rules this module exists for**

```bash
cp src/main/skills/resolve.ts /tmp/res.bak
```

Mutation A — change `if (value !== true) continue` to
`if (!(key in flags)) continue`. Run
`npx vitest run tests/unit/skillResolve.test.ts`.
Expected: **"omits a plugin whose flag is false rather than merely absent"
fails.** This is the mutation that matters most: the presence check is the
plausible wrong implementation, and without this test it passes everything
else.

```bash
cp /tmp/res.bak src/main/skills/resolve.ts
```

Mutation B — in `pick`, delete the `scoped` lookup and return the user install
directly. Run the same file.
Expected: **"takes the project-scoped install when the project matches"
fails**, and the user-scope fallback test still passes. Confirm both — a
mutation that reddens everything is not evidence that this test is specific.

```bash
cp /tmp/res.bak src/main/skills/resolve.ts && rm /tmp/res.bak
```

- [ ] **Step 6: Verify and commit**

```bash
git status --short
npm run typecheck
git add src/main/skills/resolve.ts tests/unit/skillResolve.test.ts
git commit -m "Pick the plugin install that is actually running in this project"
```

---

### Task 3: The scanner

**Files:**
- Create: `src/main/skills/scan.ts`
- Modify: `src/shared/ipc.ts` (add `SkillOrigin`, `SkillEntry`)
- Modify: `src/main/skills/resolve.ts` (import `SkillOrigin` instead of defining it)
- Test: `tests/integration/skills.test.ts`

**Interfaces:**
- Consumes: `frontmatter()` from Task 1; `pluginSkillDirs()` and `SkillSource`
  from Task 2.
- Produces:
  - `claudeHome(): string`
  - `listSkills(projectCwd: string): Promise<SkillEntry[]>`
  - In `src/shared/ipc.ts`:
    ```ts
    export type SkillOrigin =
      | { kind: 'user' }
      | { kind: 'repo' }
      | { kind: 'plugin'; plugin: string }

    export interface SkillEntry {
      /** What gets typed into a pane, without the leading slash. */
      name: string
      description: string
      kind: 'skill' | 'command'
      source: SkillOrigin
    }
    ```

- [ ] **Step 1: Move `SkillOrigin` to the shared module**

In `src/shared/ipc.ts`, beside `ResolvedPreset`, add:

```ts
/**
 * Where a skill or command came from. Declared here rather than in
 * `src/main/skills/resolve.ts`, which now imports it, because the renderer
 * draws this tag and cannot import from `src/main` to get its shape — the
 * same reason `ResolvedPreset` and `NotificationConfig` live here.
 */
export type SkillOrigin = { kind: 'user' } | { kind: 'repo' } | { kind: 'plugin'; plugin: string }

/** One row of the skills panel, and one action row of the command palette. */
export interface SkillEntry {
  /** What gets typed into a pane, without the leading slash. */
  name: string
  description: string
  kind: 'skill' | 'command'
  source: SkillOrigin
}
```

Then in `src/main/skills/resolve.ts`, delete the local `SkillOrigin`
definition and replace it with:

```ts
import type { SkillOrigin } from '../../shared/ipc'

export type { SkillOrigin }
```

- [ ] **Step 2: Write the failing test**

Create `tests/integration/skills.test.ts`. It builds a fake `~/.claude` under
a temp directory — **the real one is never read**, which is what
`PRCLI_CLAUDE_HOME` exists for.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills } from '../../src/main/skills/scan'

const saved = {
  home: process.env.PRCLI_CLAUDE_HOME,
  settings: process.env.PRCLI_CLAUDE_SETTINGS,
}

let root = ''
let home = ''
let project = ''

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prcli-skills-'))
  home = join(root, 'claude')
  project = join(root, 'project')

  await write(join(home, 'skills', 'browse', 'SKILL.md'), '---\nname: browse\ndescription: Fast browser.\n---\n')
  await write(join(home, 'commands', 'gsd', 'stats.md'), '---\nname: gsd:stats\ndescription: Show stats.\n---\n')
  // The one real command file with no `name:` — the fallback's case.
  await write(join(home, 'commands', 'gsd', 'reapply-patches.md'), '---\ndescription: Reapply.\n---\n')
  await write(join(project, '.claude', 'commands', 'ship.md'), '---\nname: ship\ndescription: Ship it.\n---\n')

  const install = join(root, 'cache', 'superpowers')
  await write(join(install, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: Shape ideas.\n---\n')
  // An enabled plugin whose install has no skills/ directory at all — 12 of
  // the 25 real installs are like this.
  const bare = join(root, 'cache', 'bare')
  await mkdir(bare, { recursive: true })

  await write(
    join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@m': [{ scope: 'user', installPath: install }],
        'bare@m': [{ scope: 'user', installPath: bare }],
      },
    }),
  )
  await write(
    join(home, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'superpowers@m': true, 'bare@m': true } }),
  )

  process.env.PRCLI_CLAUDE_HOME = home
  process.env.PRCLI_CLAUDE_SETTINGS = join(home, 'settings.json')
})

afterEach(async () => {
  process.env.PRCLI_CLAUDE_HOME = saved.home
  process.env.PRCLI_CLAUDE_SETTINGS = saved.settings
  await rm(root, { recursive: true, force: true })
})

describe('listSkills', () => {
  it('finds personal skills, personal commands, repo commands and plugin skills', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('browse')
    expect(names).toContain('gsd:stats')
    expect(names).toContain('ship')
    expect(names).toContain('brainstorming')
  })

  it('tags each entry with where it came from', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const of = (name: string) => entries.find((entry) => entry.name === name)
    expect(of('browse')?.source).toEqual({ kind: 'user' })
    expect(of('ship')?.source).toEqual({ kind: 'repo' })
    expect(of('brainstorming')?.source).toEqual({ kind: 'plugin', plugin: 'superpowers' })
  })

  it('distinguishes a skill from a command', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const of = (name: string) => entries.find((entry) => entry.name === name)
    expect(of('browse')?.kind).toBe('skill')
    expect(of('gsd:stats')?.kind).toBe('command')
  })

  it('falls back to the filename when a file declares no name', async () => {
    const entries = await listSkills(project)
    expect(entries.map((entry) => entry.name)).toContain('reapply-patches')
  })

  it('survives a plugin install with no skills directory', async () => {
    const entries = await listSkills(project)
    // The assertion is that the other entries are still here, not that some
    // internal call was skipped: `bare` contributes nothing and everything
    // else is unaffected.
    expect(entries.map((entry) => entry.name)).toContain('brainstorming')
  })

  it('returns entries rather than throwing when settings.json is damaged', async () => {
    await writeFile(join(home, 'settings.json'), '{ not json', 'utf8')
    const entries = await listSkills(project)
    // Plugins are lost — nothing said which are enabled — but the personal
    // and repo halves are independent of that file and must survive.
    expect(entries.map((entry) => entry.name)).toContain('browse')
    expect(entries.map((entry) => entry.name)).toContain('ship')
  })

  it('returns an empty list rather than throwing when nothing exists', async () => {
    await rm(home, { recursive: true, force: true })
    await expect(listSkills(join(root, 'nowhere'))).resolves.toEqual([])
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/integration/skills.test.ts`
Expected: FAIL — cannot resolve `../../src/main/skills/scan`.

- [ ] **Step 4: Write the implementation**

Create `src/main/skills/scan.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SkillEntry, SkillOrigin } from '../../shared/ipc'
import { claudeSettingsPath } from '../hooks/install'
import { frontmatter } from './frontmatter'
import { pluginSkillDirs, type SkillSource } from './resolve'

/**
 * The directory holding skills, commands and the plugin registry.
 *
 * `settings.json` is deliberately NOT resolved from here — it comes from
 * `claudeSettingsPath()`, so the app has exactly one answer for where that
 * file is. Two overrides naming one file is how they drift apart. Tests set
 * both, and `harness.ts` requires both.
 */
export function claudeHome(): string {
  return process.env.PRCLI_CLAUDE_HOME ?? join(homedir(), '.claude')
}

/**
 * Every skill and command available to one project.
 *
 * Never throws, and never writes. A damaged `settings.json`, a registry whose
 * shape changed under a Claude Code update, an unreadable directory or a
 * malformed skill file contributes nothing rather than stopping the panel from
 * opening — the same rule, for the same reason, as `projects/manifest.ts`.
 *
 * Read on every open rather than cached, so a skill written a minute ago is
 * there. The cost is that an already-open panel does not update behind the
 * user's back, which is the accepted trade.
 */
export async function listSkills(projectCwd: string): Promise<SkillEntry[]> {
  const home = claudeHome()
  const enabled = (await readJson(claudeSettingsPath())) as { enabledPlugins?: unknown } | null
  const registry = await readJson(join(home, 'plugins', 'installed_plugins.json'))

  const sources: SkillSource[] = [
    ...pluginSkillDirs(enabled?.enabledPlugins, registry, projectCwd),
  ]

  const entries: SkillEntry[] = []
  entries.push(...(await skillsIn(join(home, 'skills'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(home, 'commands'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(projectCwd, '.claude', 'commands'), { kind: 'repo' })))
  for (const source of sources) {
    entries.push(...(await skillsIn(source.dir, source.source)))
  }
  return entries
}

/** `<dir>/<name>/SKILL.md`, which is the only layout a skill directory has. */
async function skillsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const names = await listDir(dir)
  const entries: SkillEntry[] = []
  for (const name of names) {
    const parsed = await parse(join(dir, name, 'SKILL.md'))
    if (!parsed) continue
    entries.push({
      name: parsed.name ?? name,
      description: parsed.description ?? '',
      kind: 'skill',
      source,
    })
  }
  return entries
}

/**
 * Every `.md` under `dir`, at any depth.
 *
 * Depth matters: the real tree is `commands/gsd/*.md`. The command's own
 * `name:` is already namespaced (`gsd:stats`), so nothing here derives a name
 * from the path — the file says what it is called, and the filename is only
 * the fallback for the one file that does not.
 */
async function commandsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  for (const path of await walk(dir)) {
    if (!path.endsWith('.md')) continue
    const parsed = await parse(path)
    if (!parsed) continue
    entries.push({
      name: parsed.name ?? basename(path, '.md'),
      description: parsed.description ?? '',
      kind: 'command',
      source,
    })
  }
  return entries
}

async function parse(path: string): Promise<{ name?: string; description?: string } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const fields = frontmatter(text)
  return { name: fields.name || undefined, description: fields.description ?? '' }
}

async function walk(dir: string): Promise<string[]> {
  let items: Awaited<ReturnType<typeof readdir>>
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const item of items) {
    const path = join(dir, item.name)
    if (item.isDirectory()) found.push(...(await walk(path)))
    else found.push(path)
  }
  return found
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    return items.filter((item) => item.isDirectory()).map((item) => item.name)
  } catch {
    return []
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run tests/integration/skills.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: A/B the three that carry weight**

```bash
cp src/main/skills/scan.ts /tmp/scan.bak
```

Mutation A — in `parse`, change `fields.name || undefined` to `fields.name`.
Run the file.
Expected: **"falls back to the filename when a file declares no name" fails**
with a name of `undefined` or `''`. (`||` rather than `??` is deliberate: a
present-but-empty `name:` must also fall back, and `??` would keep the empty
string.)

```bash
cp /tmp/scan.bak src/main/skills/scan.ts
```

Mutation B — in `readJson`, replace the `catch` body with `throw`.
Run the file.
Expected: **"returns entries rather than throwing when settings.json is
damaged" fails.** Confirm the failure is a thrown error and not an assertion
mismatch — those are different defects.

```bash
cp /tmp/scan.bak src/main/skills/scan.ts
```

Mutation C — in `commandsIn`, replace `await walk(dir)` with a non-recursive
`await listDir(dir)`-style single-level read.
Run the file.
Expected: **"finds personal skills, personal commands, repo commands and
plugin skills" fails on `gsd:stats`**, because the real tree is nested.

```bash
cp /tmp/scan.bak src/main/skills/scan.ts && rm /tmp/scan.bak
```

- [ ] **Step 7: Verify and commit**

```bash
git status --short
npm run typecheck
npx vitest run tests/unit/frontmatter.test.ts tests/unit/skillResolve.test.ts tests/integration/skills.test.ts
git add src/main/skills/scan.ts src/shared/ipc.ts src/main/skills/resolve.ts tests/integration/skills.test.ts
git commit -m "List a project's skills and commands, reading no file it may not read"
```

---

### Task 4: The wire

**Files:**
- Modify: `src/shared/ipc.ts` (`CHANNELS.skills`, `PrcliApi.skills`)
- Modify: `src/main/ipc/register.ts` (one handler)
- Modify: `src/preload/index.ts` (one bridge line)
- Test: `tests/integration/skills.test.ts` (append)

**Interfaces:**
- Consumes: `listSkills()` from Task 3.
- Produces: `PrcliApi.skills(projectCwd: string): Promise<SkillEntry[]>`

Note the parameter: the handler takes the project's **cwd**, not its id.
`listSkills` needs a path, `ProjectDescriptor.cwd` already carries one, and
making main re-look-up an id it was not given a store read for would add a
dependency this handler does not otherwise have.

- [ ] **Step 1: Add the channel and the API method**

In `src/shared/ipc.ts`, inside `CHANNELS`, after `setLayout`:

```ts
  skills: 'prcli:skills',
```

and on `PrcliApi`, after `uninstallHooks`:

```ts
  /**
   * Every skill and command available to the project at `projectCwd`.
   *
   * Read fresh on each call rather than cached: the panel and the palette
   * both call this on open, and a skill written a minute ago should be there.
   */
  skills(projectCwd: string): Promise<SkillEntry[]>
```

In `src/preload/index.ts`, on the `api` object, after `setLayout`:

```ts
  skills: (projectCwd) => ipcRenderer.invoke(CHANNELS.skills, projectCwd),
```

- [ ] **Step 2: Write the failing test**

Append to `tests/integration/skills.test.ts`:

```ts
describe('the skills handler', () => {
  it('is registered on the channel the preload bridge invokes', async () => {
    // `register.ts` needs an Electron `ipcMain` and a real SessionManager to
    // import, neither of which exists under vitest's node environment. What
    // is checkable — and what actually breaks — is that the three sides agree
    // on one channel name and one method name. A grep is a poor test; it is
    // better than the nothing otherwise on offer, and it is the same trade
    // `shortcuts.test.ts` and `appLayout.test.ts` already make here.
    const [shared, main, bridge] = await Promise.all([
      readFile('src/shared/ipc.ts', 'utf8'),
      readFile('src/main/ipc/register.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8'),
    ])
    expect(shared).toContain("skills: 'prcli:skills'")
    expect(shared).toMatch(/skills\(projectCwd: string\): Promise<SkillEntry\[\]>/)
    expect(main).toContain('ipcMain.handle(CHANNELS.skills')
    expect(bridge).toContain('ipcRenderer.invoke(CHANNELS.skills, projectCwd)')
  })
})
```

Add `readFile` to the test file's existing `node:fs/promises` import.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/integration/skills.test.ts -t "registered on the channel"`
Expected: FAIL — `register.ts` has no `ipcMain.handle(CHANNELS.skills`.

- [ ] **Step 4: Register the handler**

In `src/main/ipc/register.ts`, add to the imports:

```ts
import { listSkills } from '../skills/scan'
```

and after the `uninstallHooks` handler at the end of the function:

```ts
  // Deliberately not inside `serialise`: this reads `~/.claude`, never PRCLI's
  // own config file, so it has nothing to serialise against — the same
  // reasoning the hooks handlers just above are registered under. Going
  // through that queue would add a deadlock risk for a panel the user is
  // looking straight at, and buy nothing.
  ipcMain.handle(CHANNELS.skills, (_event, projectCwd: string) => listSkills(projectCwd))
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run tests/integration/skills.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: A/B it**

```bash
cp src/preload/index.ts /tmp/pre.bak
```

Change the bridge line's channel to `CHANNELS.status`. Run the file.
Expected: **"is registered on the channel the preload bridge invokes" fails.**
This confirms the test pins the agreement rather than merely the existence of
three strings.

```bash
cp /tmp/pre.bak src/preload/index.ts && rm /tmp/pre.bak
```

- [ ] **Step 7: Verify and commit**

```bash
git status --short
npm run typecheck
git add src/shared/ipc.ts src/preload/index.ts src/main/ipc/register.ts tests/integration/skills.test.ts
git commit -m "Put the skill list on one channel, with all three sides naming it once"
```

---

### Task 5: The E2E safety option

Nothing in Plan 1 launches the app, so nothing in Plan 1 needs this. It lands
here anyway, and that is the point: Plan 2 opens the panel from E2E, and a
required option cannot be forgotten the way a defaulted one can. Three of the
four spec files went without `PRCLI_CLAUDE_SETTINGS` until 2026-08-02, which
is exactly the hole a default leaves.

**Files:**
- Modify: `tests/e2e/harness.ts`
- Modify: `tests/unit/e2eSafety.test.ts`

**Interfaces:**
- Consumes: `claudeHome()`'s env var name from Task 3.
- Produces: a sixth required field on the harness's launch options,
  `claudeHome: string`.

- [ ] **Step 1: Write the failing guard test**

`tests/unit/e2eSafety.test.ts` carries a required-env-var list at lines 96-99:

```ts
  'PRCLI_CONFIG_DIR',
  'PRCLI_PROJECTS_ROOT',
  'PRCLI_TMUX_SOCKET',
  'PRCLI_CLAUDE_SETTINGS',
```

Add `'PRCLI_CLAUDE_HOME',` to it, and add this test beside the existing ones:

```ts
  it('places PRCLI_CLAUDE_HOME under the temp root at the one launch site', () => {
    // ~/.claude holds 73 skills, 36 commands and the plugin registry that
    // every live Claude session on this machine reads. The app only ever
    // reads it, so the failure this prevents is not destruction — it is a
    // suite whose assertions depend on whatever was installed that week.
    expect(harness).toContain('PRCLI_CLAUDE_HOME: opts.claudeHome')
    expect(harness).toContain("assertUnderTmp('claudeHome', opts.claudeHome)")
  })
```

Use whichever variable that file already binds the harness source to; the
name above is illustrative of the assertion, not of the binding.

- [ ] **Step 2: Correct the five "all four" claims this change falsifies**

**This step is not tidying.** In this repo a comment asserting something that
is not true is a defect, and a partial sweep is worse than none — a corrected
file reads as if the sweep was done. Adding a fifth env var falsifies all six
of these at once, every one of them in `tests/unit/e2eSafety.test.ts`:

- line 29 — "four env vars are what keep that…"
- line 34 — "the one of the four that a…"
- line 38 — "copy-pasted into all four specs"
- line 39 — "does every spec set all four?" … "three of the four had drifted"
- line 253 — the test named `'sets all four env vars in the one place the app is launched from'`
- line 480 — the test named `'launches when the socket and all four paths are throwaway ones'`

Rename both tests to say **five**, and extend the four comments to name
`PRCLI_CLAUDE_HOME` alongside the others. Line 39's sentence is historical —
it describes what the guard asked *before* 2026-08-02 — so correct the claim
about today without rewriting the history.

Then re-run the sweep and confirm it is empty of this mechanism:

```bash
grep -rn "all four\|the four\|four paths\|four env" tests/ src/
```

**Scope it by mechanism, not by string.** Four other files legitimately say
"four" about something else and must not be touched: `shortcuts.test.ts:49`
(the four arrow keys), `tombstoneFrame.test.ts:149,154,550` (the four
orderings of death and restart), `appLayout.test.ts:16` (four layout
properties), and `install.test.ts:17` (four settings shapes). Only hits about
the launch env vars are in scope.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/unit/e2eSafety.test.ts`
Expected: FAIL — the harness has no `claudeHome`.

- [ ] **Step 4: Add the option to the harness**

In `tests/e2e/harness.ts`, add `claudeHome: string` to `launchApp`'s options —
**required, with no default**, exactly like the five beside it. Note the
harness has five options but only four env vars: `userDataDir` goes into
`args`, not `env`. This adds a sixth option and a fifth env var.

Add the assertion with the other five, before any spawn. **The helper is
`assertUnderTmp(label, value)` — label first:**

```ts
  assertUnderTmp('claudeHome', opts.claudeHome)
```

Add to the `env` block:

```ts
      // Holds 73 skills, 36 commands and the plugin registry that every live
      // Claude session on this machine reads. Read-only from the app's side,
      // but a suite resolving against the real one asserts against whatever
      // was installed that week.
      PRCLI_CLAUDE_HOME: opts.claudeHome,
```

- [ ] **Step 5: Give every existing launch site the new option**

Every `.ts` under `tests/e2e/` that calls the harness now fails to typecheck.
Give each one a `claudeHome` under its own temp root, alongside the
`claudeSettings` it already passes.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Run the guard and the E2E suite**

```bash
npx vitest run tests/unit/e2eSafety.test.ts
npm run e2e
```
Expected: guard PASS; E2E 42 passed. **If E2E fails on
`electronApplication.firstWindow: Timeout`, that is the known macOS AppKit
crash-restore alert, not this change** — real rate about 2 in 43 full runs.
Re-run once; if it recurs, stop and report rather than raising any timeout,
because the stall only ends when Playwright tears the process down.

- [ ] **Step 7: A/B the guard**

```bash
cp tests/e2e/harness.ts /tmp/harn.bak
```

Delete the `PRCLI_CLAUDE_HOME: opts.claudeHome` line from the env block. Run
`npx vitest run tests/unit/e2eSafety.test.ts`.
Expected: the new guard test **fails**. If it passes, the guard is decorative
and must be rewritten before this task is finished.

```bash
cp /tmp/harn.bak tests/e2e/harness.ts && rm /tmp/harn.bak
```

- [ ] **Step 8: Full gates and commit**

```bash
git status --short
npm run typecheck
npm run check-deps
npm test
npm run e2e
ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /zsh$/' | wc -l
```

Expected: typecheck and check-deps clean; `npm test` green with the new tests
added to the 1121 baseline; E2E 42 passed; tree clean.

```bash
git add tests/e2e/harness.ts tests/unit/e2eSafety.test.ts tests/e2e
git commit -m "Require every E2E launch to name its own ~/.claude, before Plan 2 needs one"
```

---

## Done when

- `frontmatter`, `pluginSkillDirs` and `listSkills` exist, are covered, and
  every A/B in this plan has been watched to fail the intended test.
- `prcli:skills` is registered and named identically in all three of
  `src/shared/ipc.ts`, `src/main/ipc/register.ts` and `src/preload/index.ts`.
- `tests/e2e/harness.ts` requires `claudeHome` and asserts it before spawn;
  `tests/unit/e2eSafety.test.ts` fails if that env line is removed.
- Typecheck, check-deps, full unit and integration, and full E2E all green on
  a branch off `master`, tree clean.

## Deliberately not in this plan

The skills panel and ⌘K (Plan 2), the context menu, tab names, drag reorder
and the onboarding screen (Plan 3), and the tab-bar collapse (Plan 4). No file
under `src/renderer/` is touched here.

## Open question this plan does not answer

Nothing. The one open question in the M4 spec — what a collapsed tab-bar entry
shows when all of its panes are tombstones — belongs to Plan 4.
