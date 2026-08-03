# M4 Plan 1b — Invocation Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `listSkills` return the string a user would actually type into
Claude Code, and stop missing the commands that plugins ship.

**Architecture:** Two changes to the module merged as Plan 1. `resolve.ts`
returns each enabled plugin's **install root** rather than its `skills/`
subdirectory, so `scan.ts` can read both `skills/` and `commands/` under it.
`scan.ts` derives every entry's name from its **path** — directory name for a
skill, path-relative-to-root for a command, prefixed `plugin:` for anything a
plugin contributed — and stops consulting frontmatter for identity.

**Tech Stack:** TypeScript, Node `fs/promises`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-prcli-m4-plan2-skills-ui-design.md`,
section "Plan 1b — the invocation name (prerequisite)".

## Why this exists

The feature Plan 2 builds is "click it, get the string you would have typed".
The string Plan 1 currently returns is wrong four ways, each measured against
what Claude Code offers in a real session:

1. **All 46 plugin entries lack their namespace** — `brainstorming` where
   Claude Code wants `superpowers:brainstorming`.
2. **Three skills return a declared name Claude Code does not offer** —
   `_gstack-command` declares `gstack`, `connect-chrome` declares
   `open-gstack-browser`, `jira-sprint-dashboard-canvas` declares
   `jira-sprint-dashboard`. In all three cases Claude Code uses the directory.
3. **A command declaring no name falls back to its bare filename** —
   `reapply-patches`, where Claude Code offers `gsd:reapply-patches`.
4. **Plugin commands are never scanned at all.** `scan.ts` reads
   `<installPath>/skills` but not `<installPath>/commands`. Six files across
   five enabled plugins are invisible: `feature-dev:feature-dev`,
   `stripe:explain-error` and one sibling, `code-review:code-review`,
   `claude-md-management:revise-claude-md`, `agent-sdk-dev:new-sdk-app`.

## Global Constraints

- **No new dependencies.** `npm install` / `npm ci` must not be run — it breaks
  node-pty's spawn-helper permissions and fails every integration test until
  the postinstall repairs it.
- **This module never throws and never writes.** A damaged `settings.json`, a
  registry whose shape changed, an unreadable directory or a malformed file
  contributes nothing rather than raising. Same rule and reason as
  `src/main/projects/manifest.ts`.
- **Nothing here writes `~/.claude`.** Only `src/main/hooks/install.ts` may
  ever write that directory.
- **Tests must never read the real `~/.claude`.** `tests/integration/skills.test.ts`
  points `PRCLI_CLAUDE_HOME` and `PRCLI_CLAUDE_SETTINGS` at a `mkdtemp` tree
  and restores both with the delete-if-undefined pattern.
- Node built-ins are imported with the `node:` prefix. TypeScript 7.0.2,
  strict; `npm run typecheck` must stay clean.
- Tests are vitest. Pure tests in `tests/unit/`, disk-touching in
  `tests/integration/`. Run one file with `npx vitest run <path>`.
- **Assert the observable, not the mechanism.**
- **A/B every load-bearing assertion, including new ones.** Confirm the
  mutation landed and that the test which went red is the one intended. Three
  tests in Plan 1 were found incapable of failing, and three of Plan 1's own
  A/B expectations were themselves wrong.
- Restore an A/B by snapshot copy (`cp file file.bak` … `cp file.bak file`).
  **Never `git checkout -- <file>`** — it has wiped uncommitted work twice here.
- **A comment asserting a mechanism that is not true is a defect** equal to a
  code defect. This branch's parent shipped that exact defect twice.

## Baseline

`master` at `5b8467c` (or later). Before this plan: **1146 tests** across 41
files, E2E 42, typecheck and `check-deps` clean.

## File Structure

| File | Change |
|---|---|
| Modify `src/main/skills/resolve.ts` | `pluginSkillDirs` → `pluginRoots`, returning the install root, not `installPath/skills` |
| Modify `tests/unit/skillResolve.test.ts` | Follow the rename and the new field |
| Modify `src/main/skills/scan.ts` | Path-derived names; scan plugin `commands/`; delete the frontmatter-name fallback and the empty-name guard |
| Modify `src/shared/ipc.ts` | Correct `SkillEntry`'s doc comment — the non-uniqueness claim becomes false |
| Modify `tests/integration/skills.test.ts` | Namespaced expectations, a plugin-commands fixture, and the declared-name-is-ignored test |

---

### Task 1: `resolve.ts` returns the install root

**Files:**
- Modify: `src/main/skills/resolve.ts`
- Test: `tests/unit/skillResolve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PluginRoot { base: string; source: SkillOrigin }`
  - `pluginRoots(enabled: unknown, registry: unknown, projectCwd: string): PluginRoot[]`
  - `SkillSource` and `pluginSkillDirs` cease to exist. Task 2 imports
    `pluginRoots` and `PluginRoot`.

- [ ] **Step 1: Rewrite the test file**

Replace `tests/unit/skillResolve.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest'
import { pluginRoots } from '../../src/main/skills/resolve'

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

describe('pluginRoots', () => {
  it('returns the install root itself, not a subdirectory of it', () => {
    // The root, because a plugin contributes BOTH `skills/` and `commands/`
    // and the caller joins whichever it is reading. Returning
    // `<installPath>/skills` is what made plugin commands unreachable.
    const roots = pluginRoots(enabled, registry, OTHER)
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.map((entry) => entry.base)).toContain('/cache/superpowers/6.2.0')
    for (const entry of roots) {
      expect(entry.base.endsWith('/skills')).toBe(false)
    }
  })

  it('takes the project-scoped install when the project matches', () => {
    const roots = pluginRoots(enabled, registry, LUMIO)
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.map((entry) => entry.base)).toContain('/cache/superpowers/6.1.1')
    expect(roots.map((entry) => entry.base)).not.toContain('/cache/superpowers/6.2.0')
  })

  it('falls back to the user-scoped install for any other project', () => {
    const roots = pluginRoots(enabled, registry, OTHER)
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.map((entry) => entry.base)).toContain('/cache/superpowers/6.2.0')
    expect(roots.map((entry) => entry.base)).not.toContain('/cache/superpowers/6.1.1')
  })

  it('omits a plugin whose flag is false rather than merely absent', () => {
    const roots = pluginRoots(enabled, registry, OTHER)
    expect(roots.length).toBeGreaterThan(0)
    for (const entry of roots) {
      expect(entry.base).not.toContain('security-guidance')
    }
  })

  it('names the plugin without its marketplace suffix', () => {
    const roots = pluginRoots(enabled, registry, OTHER)
    const found = roots.find((entry) => entry.base.includes('frontend-design'))
    expect(found).toBeDefined()
    expect(found?.source).toEqual({ kind: 'plugin', plugin: 'frontend-design' })
  })

  it('omits an enabled plugin the registry does not list', () => {
    expect(pluginRoots({ 'ghost@nowhere': true }, registry, OTHER)).toEqual([])
  })

  it('omits a plugin with no install this project can use', () => {
    const onlyOtherProject = {
      version: 2,
      plugins: {
        'scoped@m': [{ scope: 'project', projectPath: LUMIO, installPath: '/cache/scoped' }],
      },
    }
    expect(pluginRoots({ 'scoped@m': true }, onlyOtherProject, OTHER)).toEqual([])
  })

  it('contributes nothing when either input is the wrong shape', () => {
    expect(pluginRoots(null, registry, OTHER)).toEqual([])
    expect(pluginRoots(enabled, 'not an object', OTHER)).toEqual([])
    expect(pluginRoots(enabled, { plugins: 'wrong' }, OTHER)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/skillResolve.test.ts`
Expected: FAIL — `pluginRoots` is not exported.

- [ ] **Step 3: Make the change**

In `src/main/skills/resolve.ts`:

Delete the `import { join } from 'node:path'` line — nothing joins here now.

Replace the `SkillSource` interface with:

```ts
export interface PluginRoot {
  /**
   * The plugin's install root, NOT its `skills/` directory. A plugin
   * contributes both `skills/` and `commands/`; the caller joins whichever it
   * is reading. Returning the subdirectory is what made plugin commands
   * unreachable — six files across five enabled plugins on the target machine.
   */
  base: string
  source: SkillOrigin
}
```

Rename the function and its doc comment's first line, and change what it pushes:

```ts
/**
 * The install roots the enabled plugins contribute to one project.
 *
 * Pure: it is handed the two parsed files rather than reading them, for the
 * same reason `notify/rules.ts` is handed its own clock — every rule that can
 * be wrong is then testable with no disk.
 *
 * Stale cached versions and the `.cursor/skills` and `.windsurf/skills`
 * directories that other tools leave under `plugins/marketplaces/` are
 * excluded **by construction**: this only ever returns an `installPath` the
 * registry names, and none of those is one. There is deliberately no filter
 * for them.
 */
export function pluginRoots(
  enabled: unknown,
  registry: unknown,
  projectCwd: string,
): PluginRoot[] {
  const flags = asRecord(enabled)
  const plugins = asRecord(asRecord(registry).plugins)
  const roots: PluginRoot[] = []

  for (const [key, value] of Object.entries(flags)) {
    // `=== true`, not truthiness and not key-presence: this map carries
    // explicit `false` entries for plugins the user has turned off, and a
    // presence check would enable every one of them.
    if (value !== true) continue
    const installs = plugins[key]
    if (!Array.isArray(installs)) continue
    const install = pick(installs, projectCwd)
    if (!install) continue
    roots.push({
      base: install.installPath,
      source: { kind: 'plugin', plugin: key.split('@')[0] ?? key },
    })
  }
  return roots
}
```

Leave `pick`, `isInstall` and `asRecord` untouched.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/skillResolve.test.ts`
Expected: PASS, 8 tests.

`npm run typecheck` will still fail here — `scan.ts` imports the old names and
Task 2 fixes it. That is expected at this step and is not a defect.

- [ ] **Step 5: A/B the two rules this module exists for**

```bash
cp src/main/skills/resolve.ts /tmp/res.bak
```

Mutation A — change `if (value !== true) continue` to `if (!(key in flags)) continue`.
Run `npx vitest run tests/unit/skillResolve.test.ts`.
Expected: **"omits a plugin whose flag is false rather than merely absent" fails.**
This is the plausible wrong implementation; without this test it passes
everything else.

```bash
cp /tmp/res.bak src/main/skills/resolve.ts
```

Mutation B — change `base: install.installPath` to
`base: install.installPath + '/skills'`.
Run the same file.
Expected: **"returns the install root itself, not a subdirectory of it" fails**,
and the two scope tests still pass. Confirm both — a mutation that reddens
everything is not evidence this test is specific.

```bash
cp /tmp/res.bak src/main/skills/resolve.ts && rm /tmp/res.bak
```

- [ ] **Step 6: Commit**

`npm run typecheck` is expected to fail at this commit; Task 2 restores it.
Commit anyway so the two changes stay reviewable apart.

```bash
git status --short
git add src/main/skills/resolve.ts tests/unit/skillResolve.test.ts
git commit -m "Return each plugin's install root, not its skills subdirectory

A plugin ships commands as well as skills, and returning
<installPath>/skills made the commands unreachable — six files across
five enabled plugins that Claude Code does offer. The caller now joins
whichever subdirectory it is reading."
```

---

### Task 2: `scan.ts` derives names from paths, and reads plugin commands

**Files:**
- Modify: `src/main/skills/scan.ts`
- Modify: `src/shared/ipc.ts` (the `SkillEntry` doc comment only)
- Test: `tests/integration/skills.test.ts`

**Interfaces:**
- Consumes: `pluginRoots(enabled, registry, projectCwd): PluginRoot[]` and
  `interface PluginRoot { base: string; source: SkillOrigin }` from Task 1.
- Produces: `listSkills(projectCwd: string): Promise<SkillEntry[]>` unchanged in
  signature; `claudeHome()` unchanged. Only the `name` values change.

- [ ] **Step 1: Correct the `SkillEntry` doc comment**

In `src/shared/ipc.ts`, replace the `SkillEntry` doc comment. The existing one
claims names are not unique, which was measured against the frontmatter names
this task stops using. There are 119 skill directories and zero directory-name
collisions.

```ts
/**
 * One row of the skills panel, and one action row of the command palette.
 *
 * `name` is the string a user would type, derived from where the entry lives
 * rather than from anything the file declares: a skill's directory name, a
 * command's path below its root with separators as `:`, and a `plugin:` prefix
 * on anything a plugin contributed. That is what Claude Code itself offers —
 * measured three ways, including `superpowers:brainstorming` rather than bare
 * and `gsd:reapply-patches` for a file declaring no name at all.
 *
 * A file's own `name:` is deliberately ignored: three skills on the author's
 * machine declare one that differs from their directory, and in every case
 * Claude Code uses the directory.
 */
```

- [ ] **Step 2: Write the failing tests**

In `tests/integration/skills.test.ts`, extend the `beforeEach` fixture with a
plugin that ships commands, and replace the name assertions.

Add to `beforeEach`, after the existing `install` setup:

```ts
  // A plugin shipping BOTH skills and commands. Five enabled plugins on the
  // real machine ship commands, and none of them were scanned before.
  await write(join(install, 'commands', 'ship-it.md'), '---\ndescription: Ship.\n---\n')
  await write(join(install, 'commands', 'nested', 'deep.md'), '---\ndescription: Deep.\n---\n')
```

Replace the `'finds personal skills, personal commands, repo commands and plugin skills'`
test and the `'falls back to the filename when a file declares no name'` and
`'falls back to the filename when a file declares an empty name'` tests with:

```ts
  it('finds personal skills, personal commands, repo commands and plugin skills', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('browse')
    expect(names).toContain('gsd:stats')
    expect(names).toContain('ship')
    expect(names).toContain('superpowers:brainstorming')
  })

  it('namespaces a plugin skill with its plugin', async () => {
    // The defect this task exists for: `brainstorming` is not a string anyone
    // can type. `superpowers:brainstorming` is.
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.map((entry) => entry.name)).not.toContain('brainstorming')
  })

  it('scans the commands a plugin ships, at any depth', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('superpowers:ship-it')
    expect(names).toContain('superpowers:nested:deep')
  })

  it('names a command after its path below the root, not its own declaration', async () => {
    // `commands/gsd/stats.md` declares `gsd:stats` and happens to agree. The
    // file with no `name:` at all is what proves the path is the source: it
    // must come back namespaced, not as a bare filename.
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.map((entry) => entry.name)).toContain('gsd:reapply-patches')
  })

  it('ignores a declared name that differs from the directory', async () => {
    // Three skills on the author's machine do this, and Claude Code uses the
    // directory in all three cases.
    await write(
      join(home, 'skills', 'actual-dir', 'SKILL.md'),
      '---\nname: declared-something-else\ndescription: D.\n---\n',
    )
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('actual-dir')
    expect(names).not.toContain('declared-something-else')
  })
```

Leave the remaining tests (`tags each entry with where it came from`,
`distinguishes a skill from a command`, `survives a plugin install with no
skills directory`, the two never-throws tests) exactly as they are.

**Note for the reviewer, so a deleted test does not read as lost coverage.**
Three tests are removed and five added. Two of the removals —
`'falls back to the filename when a file declares no name'` and
`'falls back to the filename when a file declares an empty name'` — tested a
behaviour that no longer exists: the file's `name:` is not read, so there is
nothing to fall back *from*. The empty-name case in particular cost Plan 1 a
BLOCKED round and a measured argument, and it turned out to be guarding a field
that was never the key. `'names a command after its path below the root'` is
its honest replacement: it uses the same no-`name:` fixture and asserts the
path-derived answer. A separate empty-`name:` test is deliberately **not**
added — with the field unread, it could not fail independently of that one, and
this repo has already found twenty tests incapable of failing.

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run tests/integration/skills.test.ts`
Expected: FAIL. `superpowers:brainstorming` is absent (bare `brainstorming` is
returned), the plugin commands are absent entirely, `gsd:reapply-patches` comes
back as `reapply-patches`, and the declared name wins over the directory.

- [ ] **Step 4: Make the change**

In `src/main/skills/scan.ts`:

Change the imports — `basename` goes, `relative` and `sep` arrive, and the
resolve import follows Task 1's rename:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { SkillEntry, SkillOrigin } from '../../shared/ipc'
import { claudeSettingsPath } from '../hooks/install'
import { frontmatter } from './frontmatter'
import { pluginRoots, type PluginRoot } from './resolve'
```

Replace the body of `listSkills` from the `sources` line to the `return`:

```ts
  const roots: PluginRoot[] = pluginRoots(enabled?.enabledPlugins, registry, projectCwd)

  const entries: SkillEntry[] = []
  entries.push(...(await skillsIn(join(home, 'skills'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(home, 'commands'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(projectCwd, '.claude', 'commands'), { kind: 'repo' })))
  for (const root of roots) {
    entries.push(...(await skillsIn(join(root.base, 'skills'), root.source)))
    entries.push(...(await commandsIn(join(root.base, 'commands'), root.source)))
  }
  return entries
```

Add the name derivation above `skillsIn`:

```ts
/**
 * The string a user would type, derived from where the entry lives.
 *
 * `rel` is the entry's path below the root it was found in — a skill's
 * directory name, or a command's path with `.md` stripped. Separators become
 * `:`, and anything a plugin contributed carries its plugin as a prefix.
 *
 * This is what Claude Code itself offers, measured rather than assumed:
 * `superpowers:brainstorming` rather than bare, `gsd:reapply-patches` for the
 * one command file declaring no name, and the directory name for all three
 * skills whose `name:` disagrees with it.
 */
function entryName(rel: string, source: SkillOrigin): string {
  const local = rel.split(sep).join(':')
  return source.kind === 'plugin' ? `${source.plugin}:${local}` : local
}
```

Replace `skillsIn`:

```ts
/** `<dir>/<name>/SKILL.md`, which is the only layout a skill directory has. */
async function skillsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  for (const name of await listDir(dir)) {
    const description = await readDescription(join(dir, name, 'SKILL.md'))
    if (description === null) continue
    entries.push({ name: entryName(name, source), description, kind: 'skill', source })
  }
  return entries
}
```

Replace `commandsIn`:

```ts
/**
 * Every `.md` under `dir`, at any depth, named after its path below `dir`.
 *
 * Depth matters and is where the name comes from: `commands/gsd/stats.md` is
 * `gsd:stats`. The file's own `name:` is not consulted — it agrees in almost
 * every case, and where it disagrees Claude Code uses the path.
 */
async function commandsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  for (const path of await walk(dir)) {
    if (!path.endsWith('.md')) continue
    const description = await readDescription(path)
    if (description === null) continue
    const rel = relative(dir, path).slice(0, -'.md'.length)
    entries.push({ name: entryName(rel, source), description, kind: 'command', source })
  }
  return entries
}
```

Replace `parse` with `readDescription`:

```ts
/** The file's declared description, or null when it cannot be read at all. */
async function readDescription(path: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  return frontmatter(text).description ?? ''
}
```

Leave `claudeHome`, `walk`, `listDir` and `readJson` untouched.

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run tests/integration/skills.test.ts`
Expected: PASS, 11 tests.

Run: `npm run typecheck`
Expected: clean — this is where Task 1's rename becomes consistent again.

- [ ] **Step 6: A/B the three rules this task exists for**

```bash
cp src/main/skills/scan.ts /tmp/scan.bak
```

Mutation A — in `entryName`, drop the prefix: replace the return with
`return local`. Run `npx vitest run tests/integration/skills.test.ts`.
Expected: **"namespaces a plugin skill with its plugin" fails**, and
"scans the commands a plugin ships, at any depth" fails with it. Two failures,
both about the prefix.

```bash
cp /tmp/scan.bak src/main/skills/scan.ts
```

Mutation B — in `listSkills`, delete the
`entries.push(...(await commandsIn(join(root.base, 'commands'), root.source)))`
line. Run the file.
Expected: **"scans the commands a plugin ships, at any depth" fails**, and
"namespaces a plugin skill with its plugin" still passes. Confirm both.

```bash
cp /tmp/scan.bak src/main/skills/scan.ts
```

Mutation C — in `commandsIn`, replace the `rel` line with
`const rel = relative(dir, path).split(sep).pop()!.slice(0, -'.md'.length)`,
i.e. use the basename instead of the path. Run the file.
Expected: **"names a command after its path below the root, not its own
declaration" fails** on `gsd:reapply-patches`.

```bash
cp /tmp/scan.bak src/main/skills/scan.ts && rm /tmp/scan.bak
```

- [ ] **Step 7: Full gates and commit**

```bash
git status --short
npm run typecheck
npm run check-deps
npm test
ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /zsh$/' | wc -l
```

Expected: typecheck and check-deps clean; `npm test` green, with the test count
up from the 1146 baseline. Before believing any integration failure is a
defect, count `posix_spawnp failed`, `Device not configured` and `fork failed`
— **inside assertion text as well as error lines**. 91 orphan shells is what
starves this machine.

E2E is not affected by this task — no launch path reads `listSkills` yet — but
run it once to confirm that:

```bash
npm run e2e
```

Expected: 42 passed. If it fails on `electronApplication.firstWindow: Timeout`,
that is the known macOS AppKit crash-restore alert, not this change; re-run
once, and if it recurs stop and report rather than raising any timeout.

```bash
git add src/main/skills/scan.ts src/shared/ipc.ts tests/integration/skills.test.ts
git commit -m "Name every entry the way Claude Code does, and scan plugin commands

The name a file declares is not the string anyone types. Claude Code
keys on the path: a skill's directory, a command's path below its root,
and a plugin prefix on both. Measured three ways — it offers
_gstack-command and connect-chrome over their declared names,
atlassian:jira-sprint-dashboard-canvas over jira-sprint-dashboard,
superpowers:brainstorming rather than bare, and gsd:reapply-patches for
the one command file declaring no name at all.

Plugin commands were never scanned. Six files across five enabled
plugins were invisible to the panel that is about to read this.

Three things fall out as deletions: the frontmatter-name fallback, the
empty-name guard that protected a field that was never the key, and
SkillEntry's not-unique comment — 119 skill directories, zero
collisions."
```

---

## Done when

- Every entry's `name` is path-derived and plugin-prefixed, and the three
  A/B mutations each redden the intended test.
- `listSkills` returns plugin commands as well as plugin skills.
- The frontmatter-name fallback, the `|| undefined` empty-name guard and
  `SkillEntry`'s non-uniqueness comment are gone.
- Typecheck, check-deps, the full suite and E2E are green, tree clean, on a
  branch off `master`.

## Deliberately not in this plan

The skills panel, the filter, the shared matcher and ⌘K — all Plan 2. No file
under `src/renderer/` is touched here. Ordering of entries is unchanged and
still unpinned; the spec records it as Plan 2's to decide if it matters.
