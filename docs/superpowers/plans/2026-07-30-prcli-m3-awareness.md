# PRCLI Milestone 3 — Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Know, without looking, which of twelve sessions is blocked on you.

**Architecture:** Claude Code hooks write one line per event to a Unix socket in the main process; a pure state machine turns those into per-tab states, aggregated worst-first onto project rows. The main process owns the state — notifications, sounds and the dock badge all live there, and ⌘R must not blank the board. Events arriving while the app is down spool to a file and replay at launch, because a session sitting in `waiting` does nothing that would fire another hook.

**Tech Stack:** Electron 43.2.0, TypeScript 7.0.2 (strict), Vite via Electron Forge 7.11.2, node-pty 1.1.0, @xterm/xterm 6.0.0, React 19.2.0, Tailwind v4, Vitest 4.1.10, Playwright 1.62.0, tmux 3.7b, Node 25.8.1. New in this milestone: ESLint 9 with flat config and typescript-eslint v8. No new runtime dependencies — the hook script uses `/usr/bin/nc` and `/bin/sh`, both of which macOS ships.

**Size note:** 17 tasks. Tasks 1–9 are pure logic and file-level plumbing with real tests and no UI; 10–13 wire the main process together; 14–16 are renderer; 17 is end-to-end. If execution slips, the natural cut is after Task 13: everything up to there is a working bridge with no way to see it, and 14–17 is the way to see it.

## Global Constraints

- Platform: macOS only. No Windows or Linux branches.
- All tmux invocations go through `TmuxAdapter`. No `execFile('tmux', …)` elsewhere in app code. Test files may call tmux directly.
- Every tmux session name is `prcli-<projectSlug>-<id>`, built only via `encodeSessionName`.
- **Slugs match `/^[a-z0-9_]+$/` — underscores, never dashes.** `decodeSessionName` splits on exactly three dash-separated parts.
- **A tab belongs to a project by the slug inside its tmux session name, never by a stored id.**
- **Live tmux decides what exists; config supplies only order and selection.**
- **The durable record and the attached-client set are different things. Never infer a session's death from a client's death.**
- **Any new attach path must carry the client's live geometry**, or tmux resizes the session to 80×24 and reflows the user's scrollback permanently. This has already shipped as a defect on two separate paths. **Restart (Task 10) is a new attach path.**
- `register.ts`'s `serialise` queue has **no reentrancy protection** — nothing reached from inside it may call `serialise`, or it deadlocks silently with no error.
- `ConfigStore.read()` never throws. A malformed or future-version config must not stop the app starting.
- Integration tests use the dedicated tmux socket `-L prcli-test`; E2E uses `PRCLI_TMUX_SOCKET` (`prcli-e2e`, `prcli-e2e-tabs`, `prcli-e2e-projects`, and new here `prcli-e2e-status`). **Neither may ever touch the developer's own tmux server, which holds live irreplaceable sessions. Never run a bare `tmux kill-server`.**
- Tests must never read or write the real `~/.prcli` (use `PRCLI_CONFIG_DIR`), the real `~/Code` (use `PRCLI_PROJECTS_ROOT`), or — **new in this milestone** — the real `~/.claude/settings.json` (use `PRCLI_CLAUDE_SETTINGS`). That file is read by every live Claude session on this machine.
- `node-pty` is main-process only; renderer code imports no Node built-ins and reaches privilege only through `window.prcli`.
- `tsconfig.json` has `"strict": true`. No `any`, no non-null assertions, no `@ts-` suppressions.
- Never weaken, loosen or delete an existing test assertion to make something pass. If a test contradicts the code, stop and report it.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-07-30-prcli-m3-awareness-design.md`. Parent design of record: `docs/superpowers/specs/2026-07-30-prcli-design.md`.

## Existing interfaces this milestone builds on

- `src/main/tmux/names.ts` — `SESSION_PREFIX`, `slugify(name)`, `newSessionId()`, `encodeSessionName({projectSlug,id})`, `decodeSessionName(name)`, `isPrcliSession(name)`
- `src/main/tmux/adapter.ts` — `TmuxAdapter({bin?,socket?})`, `baseArgs()`, `version()`, `listSessions()`, `listPrcliSessions()`, `hasSession(name)`, `killSession(name)`, `renameSession(from,to)`, `setSessionOption`, `getSessionOption`; `TmuxNotInstalledError`
- `src/main/pty/session.ts` — `PtySession(adapter, options)`; `PtySessionOptions` already declares `env?: NodeJS.ProcessEnv`, **which nothing passes today**
- `src/main/sessions/manager.ts` — `SessionManager(adapter)` with `open(OpenInput)`, `get`, `list`, `write`, `resize`, `detach`, `detachAll`, `kill`, `moveToProject`, `hasSession`, `findOrphans`, `onData`, `onExit`; types `TabRecord`, `OpenInput`, `ExitReason`
- `src/main/state/store.ts` — `ConfigStore(filePath)` with `read()`, `write(config)`, `static defaultPath()`; `PrcliConfig` (v3), `ProjectRecord`, `Preset`
- `src/main/ipc/restore.ts` — `describeProjects(projects, tabs)`, `withUnsorted(projects, tabs)`, `restoreWorkspace(manager, store, serialise)`
- `src/main/ipc/register.ts` — `registerIpc(manager, getWindow, store?)`; owns the `serialise` queue, `rememberTab`, `forgetTab`, `pendingKills`, `sessionSurvived`
- `src/main/projects/projects.ts` — `addProject`, `updateProject`, `removeProject`, `reorderProjects`, `projectForSlug(config, slug)`
- `src/shared/ipc.ts` — `CHANNELS`, `TabDescriptor`, `OpenRequest`, `DataEvent`, `ExitEvent`, `ProjectDescriptor`, `Preset`, `ResolvedPreset`, `Candidate`, `RestoreResult`, `PrcliApi`, `UNSORTED_ID`
- `src/renderer/workspace.ts` — `WorkspaceState`, `WorkspaceAction`, `INITIAL_WORKSPACE_STATE`, `neighbourOf`, `projectIdForTab`, `tabsOfProject`, `activeProject`, `activeTabId`, `workspaceReducer`
- `src/renderer/lib/cn.ts` — `cn(...inputs)`; `src/renderer/ui/Button.tsx`, `src/renderer/ui/Dialog.tsx`

## File Structure

| File | Responsibility |
|---|---|
| `eslint.config.mjs` | Flat ESLint config — the repo's first |
| `src/shared/status.ts` | `TabState`, `SEVERITY`, `worst()` — shared by main and renderer |
| `src/shared/ipc.ts` (modify) | `TabType`, status/hooks/notification wire types and channels |
| `src/main/state/store.ts` (modify) | Config v4, v3→v4 migration, tab element validation, `configRoot()` |
| `src/main/status/machine.ts` | Pure. `stateForHook`, `stateForExit`, `stateForOpen` |
| `src/main/status/registry.ts` | State per tab id; transition events; waiting count |
| `src/main/hooks/protocol.ts` | `HOOK_EVENTS`, `parseHookLine` — the wire format, in one place |
| `src/main/hooks/server.ts` | Unix socket listener |
| `src/main/hooks/spool.ts` | Rotate-and-drain the offline event file |
| `src/main/hooks/install.ts` | Script rendering, `~/.claude/settings.json` merge/unmerge, backup |
| `src/main/notify/rules.ts` | Pure rule resolution and the shipped defaults |
| `src/main/notify/router.ts` | Electron `Notification`, `afplay`, dock badge |
| `src/main/sessions/manager.ts` (modify) | `PRCLI_TAB_ID` in the session env; `type` on the record |
| `src/main/ipc/restore.ts` (modify) | Carry `type`; write v4 |
| `src/main/ipc/register.ts` (modify) | Status, restart, dismiss, hooks and notification channels |
| `src/main/index.ts` (modify) | Start the server, drain the spool, own the router |
| `src/preload/index.ts` (modify) | Expose the new channels |
| `src/renderer/workspace.ts` (modify) | `status` map, dead-tab tombstones |
| `src/renderer/StatusDot.tsx` | One dot, one state — the only place colour maps to state |
| `src/renderer/NeedsYou.tsx` | Pinned list of every tab that is blocking a human |
| `src/renderer/SettingsPane.tsx` | Hook install row, per-state notification rows |
| `src/renderer/Sidebar.tsx` (modify) | Tab dots, aggregated project dot, per-project mute |
| `src/renderer/TabBar.tsx` (modify) | Tab dots, Restart and Dismiss for a dead tab |
| `src/renderer/App.tsx` (modify) | Subscribe to status; stop removing dead tabs |
| `tests/unit/status.test.ts` | `worst()` and the severity order |
| `tests/unit/protocol.test.ts` | The wire format, including every malformed shape |
| `tests/unit/registry.test.ts` | State per tab, transitions, waiting count |
| `tests/unit/rules.test.ts` | Rule resolution, precedence, mute, quiet hours |
| `tests/unit/router.test.ts` | Toast, sound and badge decisions with effects injected |
| `tests/integration/spool.test.ts` | Rotate-and-drain, age and cap |
| `tests/integration/install.test.ts` | Backup, script install, idempotency, restore on uninstall |
| `tests/unit/machine.test.ts` | The transition table, exhaustively |
| `tests/unit/rules.test.ts` | Rule resolution, precedence, mute, quiet hours |
| `tests/unit/install.test.ts` | Merge and unmerge against a realistic settings fixture |
| `tests/unit/store.test.ts` (modify) | v3→v4 migration and tab element validation |
| `tests/unit/workspace.test.ts` (modify) | Status and tombstone reducer cases |
| `tests/integration/hook-script.test.ts` | The script executed as a subprocess |
| `tests/integration/hook-server.test.ts` | Real socket, real spool |
| `tests/integration/manager.test.ts` (modify) | `PRCLI_TAB_ID` reaching the session |
| `tests/e2e/status.spec.ts` | The milestone end to end |

---

### Task 1: The lint gate

Three milestones have shipped without one. Checked, not assumed: ESLint 8.57.1 is installed and `--ext` is valid for that version — the only reason `npm run lint` fails today is that no config file exists anywhere in the repo or its ancestors. The installed `@typescript-eslint` packages are v5, which predates TypeScript 5 and cannot be trusted against the 7.0.2 in use, so this moves to ESLint 9 flat config with typescript-eslint v8.

This goes first because every task after it writes new surface — a shell script, a socket protocol, a rules engine — and an unused import or a floating promise in any of it should fail a gate rather than survive to the review. `lucide-react` sitting in `dependencies` imported nowhere is what the absence of this gate already cost.

**Files:**
- Create: `eslint.config.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run lint` as a command later tasks must keep green

- [ ] **Step 1: Replace the ESLint packages**

Run:

```bash
npm rm @typescript-eslint/eslint-plugin @typescript-eslint/parser
npm i -D eslint@latest typescript-eslint@latest
```

Then record what resolved — the plan deliberately does not pin these, because they must be checked live rather than guessed:

Run: `node -e "const p=require('./package.json');console.log(JSON.stringify(p.devDependencies,null,1))"`

Put the resolved versions of `eslint` and `typescript-eslint` in your report.

- [ ] **Step 2: Drop the dependency nothing imports**

Confirm it really is unused before removing it:

Run: `grep -rn "lucide-react" src tests *.ts *.mts *.json --include='*' | grep -v package-lock`

Expected: only the `package.json` line. If anything in `src/` matches, stop and report it — the premise is wrong.

Run: `npm rm lucide-react`

- [ ] **Step 3: Write the flat config**

Create `eslint.config.mjs`:

```js
// The repo's first ESLint config. Flat config is ESLint 9's only format.
//
// Deliberately narrow: this is a gate against the mistakes that have actually
// reached master — an unused import, a dependency nothing uses, a floating
// promise — not a style engine. Formatting is not litigated here.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Build output and vendored code. `.vite` is Forge's bundle directory and
    // contains the whole renderer graph concatenated; linting it is minutes of
    // work to no purpose.
    ignores: ['.vite/**', 'dist/**', 'out/**', 'node_modules/**', 'test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    rules: {
      // The rule that would have caught lucide-react's sibling mistake: an
      // import of something that does not exist or is never used.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // tsconfig already forbids these; failing here too means a lint run
      // alone catches them in a file typecheck has not reached yet.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // Tests reach into internals and use fixtures that look unused.
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
```

- [ ] **Step 4: Fix the script**

In `package.json`, replace the `lint` line. ESLint 9 removed `--ext`; flat config takes paths instead:

```json
    "lint": "eslint .",
```

- [ ] **Step 5: Run it, and fix what it finds**

Run: `npm run lint`

Expected: it *runs*. It may report errors — this is the first time any of this code has been linted.

Fix every error it reports. Do not silence a rule to make it pass, and do not add `eslint-disable` comments. If a rule reports something you believe is wrong rather than something the code got wrong, leave it, note it in your report, and say why — that is a judgement worth surfacing rather than burying.

Warnings may be left if fixing one would change behaviour; say which in your report.

- [ ] **Step 6: Verify nothing else broke**

Run: `npm run typecheck && npm test`

Expected: typecheck clean, 211 tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Give the repo a lint gate

Three milestones with none. eslint 8.57.1 was installed and --ext was
valid for it — the only reason `npm run lint` had never run is that no
config file existed anywhere in the repo or its ancestors, so the script
failed before reaching a single file.

Moved to ESLint 9 flat config with typescript-eslint v8. The installed
@typescript-eslint packages were v5, which predates TypeScript 5 and
cannot be trusted against the 7.0.2 this repo is on.

Also drops lucide-react, a dependency imported nowhere since 2b
installed it. That is the concrete thing the missing gate cost, and the
reason this goes in before a milestone that adds a shell script, a
socket protocol and a rules engine.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The shared status vocabulary

One tiny module, created before anything that needs it, because **both** processes need it: main runs the state machine and the dock badge, the renderer draws dots and aggregates a project row from its tabs. A second copy of the severity order in the renderer is a copy that can disagree with the one notifications fire from.

**Files:**
- Create: `src/shared/status.ts`
- Test: `tests/unit/status.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type TabState = 'crashed' | 'waiting' | 'thinking' | 'running' | 'idle' | 'ended' | 'unknown'`
  - `const SEVERITY: readonly TabState[]` — worst first
  - `worst(states: readonly TabState[]): TabState | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SEVERITY, worst, type TabState } from '../../src/shared/status'

describe('worst', () => {
  it('returns null for no states, so an empty project draws no dot', () => {
    expect(worst([])).toBeNull()
  })

  it('picks the more severe of two', () => {
    expect(worst(['idle', 'waiting'])).toBe('waiting')
    expect(worst(['waiting', 'crashed'])).toBe('crashed')
  })

  it('is order-independent', () => {
    expect(worst(['crashed', 'idle', 'thinking'])).toBe('crashed')
    expect(worst(['thinking', 'idle', 'crashed'])).toBe('crashed')
  })

  // The whole point of the order: a project row exists to tell you whether
  // anything under it needs a human, and `waiting` is the only state that
  // means that. It must beat every state except an outright crash.
  it('ranks waiting above everything but crashed', () => {
    for (const state of SEVERITY) {
      if (state === 'crashed' || state === 'waiting') continue
      expect(worst([state, 'waiting'])).toBe('waiting')
    }
  })

  it('ranks a finished tab below a live idle one, and unknown last of all', () => {
    expect(worst(['ended', 'idle'])).toBe('idle')
    expect(worst(['unknown', 'ended'])).toBe('ended')
  })

  // A state missing from SEVERITY would silently never win, so a dot would
  // quietly show the wrong thing rather than failing loudly.
  it('ranks every state in the union', () => {
    const all: TabState[] = [
      'crashed',
      'waiting',
      'thinking',
      'running',
      'idle',
      'ended',
      'unknown',
    ]
    expect([...SEVERITY].sort()).toEqual([...all].sort())
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/status.test.ts`

Expected: FAIL — cannot resolve `../../src/shared/status`.

- [ ] **Step 3: Write the module**

Create `src/shared/status.ts`:

```ts
/**
 * What a tab is doing.
 *
 * Claude tabs move between `unknown`, `idle`, `thinking` and `waiting` from
 * hook events. Everything else moves between `running`, `ended` and `crashed`
 * from its exit code. `waiting` is the only state that means *you* are the
 * blocker; the rest are informational.
 *
 * Shared between processes deliberately: main fires notifications off these
 * and the renderer draws them, and a second copy of the order below is a copy
 * that can disagree with the one the dock badge counts.
 */
export type TabState =
  | 'crashed'
  | 'waiting'
  | 'thinking'
  | 'running'
  | 'idle'
  | 'ended'
  | 'unknown'

/** Worst first. A project row takes the worst state among its tabs. */
export const SEVERITY: readonly TabState[] = [
  'crashed',
  'waiting',
  'thinking',
  'running',
  'idle',
  'ended',
  'unknown',
]

/**
 * The most severe state present, or null when there is none to report — an
 * empty project, or one whose tabs are all shells nothing has been run in.
 * Null means "draw no dot", which is different from `unknown`, which means
 * "this should have a state and does not".
 */
export function worst(states: readonly TabState[]): TabState | null {
  for (const candidate of SEVERITY) {
    if (states.includes(candidate)) return candidate
  }
  return null
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/status.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/status.ts tests/unit/status.test.ts
git commit -m "$(cat <<'EOF'
Give both processes one severity order

TabState, SEVERITY and worst() live in src/shared because main and the
renderer both need them: main fires notifications and counts the dock
badge from these, the renderer draws the dots and aggregates a project
row from its tabs. A second copy in the renderer is a copy that can
disagree with the one a notification fired from.

worst() returns null rather than a state for an empty set. "Draw no dot"
and "this should have a state and does not" are different answers, and
only the second is `unknown`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Config v4 — tab type, notifications, and tab validation

Three changes to `store.ts`, together because they are one migration and one round of validation.

`type` is a declaration of intent: it drives the launch command and the expecting-hooks dot, and **nothing else**. It does not gate whether a tab can have status — every tab gets `PRCLI_TAB_ID` in Task 9, because the way this app is used is to open a tab and type `claude` into it.

The tab element validation closes a carried-forward hole: `tabs: [null]` currently survives `read()` and then crashes `restore.ts`, defeating the never-throws contract. Project *rows* have been validated since v3; this brings tabs to the same standard while the function is open anyway.

**Files:**
- Modify: `src/main/state/store.ts`, `src/shared/ipc.ts`
- Test: `tests/unit/store.test.ts` (modify)

**Interfaces:**
- Consumes: `TabState` from `src/shared/status.ts` (Task 2)
- Produces:
  - `type TabType = 'claude' | 'preset' | 'shell'` (in `src/shared/ipc.ts`)
  - `interface Rule { on?: TabState; project?: string; toast?: boolean; sound?: string | null; urgency?: 'low' | 'high' }`
  - `interface NotificationConfig { rules: Rule[]; muteWhenFocused: boolean; quietHours: { from: string; to: string } | null }`
  - `PrcliConfig` at `version: 4` with `notifications: NotificationConfig`
  - `TabRecord.type: TabType`, `TabDescriptor.type: TabType`, `OpenRequest.type?: TabType`
  - `configRoot(): string` — the directory `PRCLI_CONFIG_DIR` names, which the hook socket, spool and script all live in
  - `DEFAULT_NOTIFICATIONS: NotificationConfig`

- [ ] **Step 1: Add the wire types**

In `src/shared/ipc.ts`, add after the `UNSORTED_ID` declaration:

```ts
/**
 * What a tab was launched as.
 *
 * A declaration of intent, not a gate on status: it decides the launch command
 * and whether an expecting-hooks dot is drawn before any event has arrived.
 * Every tab carries PRCLI_TAB_ID regardless, so a `claude` typed by hand into
 * a shell tab gets full status the moment its first hook lands.
 */
export type TabType = 'claude' | 'preset' | 'shell'

/** A notification rule, exactly as it is stored. */
export interface Rule {
  /** Absent matches every state. */
  on?: TabState
  /** Project id. Absent is global. */
  project?: string
  toast?: boolean
  /** A macOS system sound name, e.g. "Funk". Null is silence. */
  sound?: string | null
  urgency?: 'low' | 'high'
}

export interface NotificationConfig {
  rules: Rule[]
  /** Suppress a toast for the tab you are already looking at. */
  muteWhenFocused: boolean
  /** Honoured by the rules engine; no editor ships in M3. */
  quietHours: { from: string; to: string } | null
}
```

Add the import at the top of the file:

```ts
import type { TabState } from './status'
```

and re-export it, so consumers have one place to import wire types from:

```ts
export type { TabState }
```

Then add `type` to the two tab shapes in the same file:

```ts
export interface TabDescriptor {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
  type: TabType
}

export interface OpenRequest {
  projectSlug: string
  cwd: string
  command?: string
  id?: string
  cols?: number
  rows?: number
  /** Defaults to 'shell' when absent. */
  type?: TabType
}
```

- [ ] **Step 2: Write the failing tests**

In `tests/unit/store.test.ts`, add these cases. Keep every existing test exactly as it is — the v1→v3 and v2→v3 cases still describe real files on disk and must keep passing.

```ts
  it('migrates a v3 config to v4, typing tabs by whether they carry a command', async () => {
    const store = await storeWith({
      version: 3,
      projects: [],
      activeProjectId: null,
      tabs: [
        { id: 'a'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'prcli-lumio-' + 'a'.repeat(16) },
        {
          id: 'b'.repeat(16),
          projectSlug: 'lumio',
          cwd: '/tmp',
          command: 'npm run dev',
          tmuxSession: 'prcli-lumio-' + 'b'.repeat(16),
        },
      ],
    })

    const config = await store.read()

    expect(config.version).toBe(4)
    // A v3 tab cannot say whether it was running Claude, and it does not need
    // to: hooks decide. Only the launch command is knowable from the record.
    expect(config.tabs[0]?.type).toBe('shell')
    expect(config.tabs[1]?.type).toBe('preset')
  })

  it('gives a migrated config the default notification rules', async () => {
    const store = await storeWith({ version: 3, projects: [], activeProjectId: null, tabs: [] })

    const config = await store.read()

    expect(config.notifications.muteWhenFocused).toBe(true)
    expect(config.notifications.quietHours).toBeNull()
    // Sound is off by design: this machine's ~/.claude/settings.json already
    // plays Funk on Notification and Glass on Stop, so shipping the parent
    // spec's default sounds would double-fire them.
    expect(config.notifications.rules.every((rule) => rule.sound === null)).toBe(true)
    expect(config.notifications.rules.some((rule) => rule.on === 'waiting')).toBe(true)
  })

  it('substitutes defaults for a v4 notifications block that is not an object', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [],
      notifications: 'nonsense',
    })

    const config = await store.read()

    // Losing every open tab because a rules array was hand-edited badly is not
    // a trade read()'s never-throws contract permits.
    expect(config.notifications.muteWhenFocused).toBe(true)
    expect(Array.isArray(config.notifications.rules)).toBe(true)
  })

  it('keeps a v4 notifications block the user has edited', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [],
      notifications: {
        rules: [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }],
        muteWhenFocused: false,
        quietHours: { from: '22:00', to: '07:00' },
      },
    })

    const config = await store.read()

    expect(config.notifications.rules).toEqual([
      { on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' },
    ])
    expect(config.notifications.muteWhenFocused).toBe(false)
    expect(config.notifications.quietHours).toEqual({ from: '22:00', to: '07:00' })
  })

  // The carried-forward hole. `read()` promises never to throw, and it did not
  // — it handed restore.ts a null it then dereferenced, which is the same
  // failure one frame later.
  it('drops a tab element that is not a tab, rather than handing it on', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [
        null,
        { id: 'c'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'prcli-lumio-' + 'c'.repeat(16), type: 'shell' },
        { id: 'no-cwd', projectSlug: 'lumio', tmuxSession: 'x' },
      ],
      notifications: { rules: [], muteWhenFocused: true, quietHours: null },
    })

    const config = await store.read()

    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0]?.id).toBe('c'.repeat(16))
  })

  it('defaults a v4 tab missing its type rather than dropping the tab', async () => {
    const store = await storeWith({
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs: [
        { id: 'd'.repeat(16), projectSlug: 'lumio', cwd: '/tmp', tmuxSession: 'prcli-lumio-' + 'd'.repeat(16) },
      ],
      notifications: { rules: [], muteWhenFocused: true, quietHours: null },
    })

    const config = await store.read()

    // A live session is worth more than a correct type field.
    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0]?.type).toBe('shell')
  })
```

If `tests/unit/store.test.ts` has no `storeWith` helper, add one modelled on whatever the file already uses to write a config file into a temp directory, and reuse the existing helper if there is one under another name. Read the file before adding, and match it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/store.test.ts`

Expected: the six new tests FAIL — `config.version` is 3, `config.notifications` is undefined.

Existing tests still pass at this point except any that assert `version: 3` on a *written* config; those are updated in Step 4 and their assertions must move to 4, not be deleted.

- [ ] **Step 4: Rewrite the migration**

In `src/main/state/store.ts`, replace everything from the `ProjectRecord` interface through the end of `migrate` with:

```ts
export interface ProjectRecord {
  id: string
  /** Display name. Freely renameable — the slug does not follow it. */
  name: string
  /** Immutable once allocated: it is baked into every session name. */
  slug: string
  cwd: string
  /** User-defined only. Repo presets merge in above this at read time. */
  presets: Preset[]
  /** Per-project, so returning to a project lands where you left it. */
  activeTabId: string | null
}

export interface PrcliConfig {
  version: 4
  /** Array order is sidebar order, and the order ⌘1–9 follows. */
  projects: ProjectRecord[]
  activeProjectId: string | null
  tabs: TabRecord[]
  notifications: NotificationConfig
}

/**
 * Toast on, sound off.
 *
 * The parent spec names Funk for `waiting` and Glass for `idle`, but this
 * machine's ~/.claude/settings.json already runs `afplay` on Notification and
 * Stop with exactly those two sounds, so shipping them would double-fire. The
 * install screen names the collision instead, and the pickers start unset.
 */
export const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  rules: [
    { on: 'waiting', toast: true, sound: null, urgency: 'high' },
    { on: 'crashed', toast: true, sound: null, urgency: 'high' },
    { on: 'idle', toast: true, sound: null, urgency: 'low' },
  ],
  muteWhenFocused: true,
  quietHours: null,
}

const EMPTY: PrcliConfig = {
  version: 4,
  projects: [],
  activeProjectId: null,
  tabs: [],
  notifications: DEFAULT_NOTIFICATIONS,
}

function hasTabs(value: unknown): value is { version: number; tabs: unknown[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return typeof candidate.version === 'number' && Array.isArray(candidate.tabs)
}

function isProject(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<ProjectRecord>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.slug === 'string' &&
    typeof p.cwd === 'string'
  )
}

/**
 * A tab row that restore can actually use.
 *
 * Validated for the same reason project rows are: `read()` promises never to
 * throw, and handing `restore.ts` a `null` it dereferences is that promise
 * broken one frame later rather than kept. A row missing only its optional
 * `type` is normalised, not dropped — a live session is worth more than a
 * correct type field.
 */
function isTab(value: unknown): value is TabRecord {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Partial<TabRecord>
  return (
    typeof t.id === 'string' &&
    typeof t.projectSlug === 'string' &&
    typeof t.cwd === 'string' &&
    typeof t.tmuxSession === 'string'
  )
}

const TAB_TYPES: readonly TabType[] = ['claude', 'preset', 'shell']

function normaliseTab(tab: TabRecord): TabRecord {
  if (TAB_TYPES.includes(tab.type)) return tab
  // A v3 row cannot say whether it was running Claude, and does not need to —
  // hooks decide that. Only the launch command is knowable from the record.
  return { ...tab, type: tab.command === undefined ? 'shell' : 'preset' }
}

/** Tolerate a project row missing its optional arrays rather than dropping it. */
function normaliseProject(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    presets: Array.isArray(project.presets) ? project.presets : [],
    activeTabId: typeof project.activeTabId === 'string' ? project.activeTabId : null,
  }
}

/**
 * Same tolerance the project rows get: a hand-edited rules array that is the
 * wrong shape costs its own contents, not every open tab.
 */
function normaliseNotifications(value: unknown): NotificationConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_NOTIFICATIONS
  const n = value as Partial<NotificationConfig>
  return {
    rules: Array.isArray(n.rules) ? n.rules : DEFAULT_NOTIFICATIONS.rules,
    muteWhenFocused:
      typeof n.muteWhenFocused === 'boolean'
        ? n.muteWhenFocused
        : DEFAULT_NOTIFICATIONS.muteWhenFocused,
    quietHours:
      typeof n.quietHours === 'object' &&
      n.quietHours !== null &&
      typeof n.quietHours.from === 'string' &&
      typeof n.quietHours.to === 'string'
        ? { from: n.quietHours.from, to: n.quietHours.to }
        : null,
  }
}

/**
 * v1 had no active tab. v2 had one, globally — a notion v3 replaced with one
 * per project, so it is dropped rather than guessed at. v4 adds a tab type and
 * notification rules; neither is derivable from an older file, so both take
 * defaults.
 *
 * Neither v1 nor v2 had projects, and their tabs all carry the slug of the
 * single hardcoded project that no longer exists. Synthesising a project from
 * that slug is the auto-create-from-slug behaviour M2b rejected, so migrated
 * tabs belong to nothing and restore lists them under Unsorted.
 */
function migrate(value: unknown): PrcliConfig {
  if (!hasTabs(value)) return { ...EMPTY }

  // Every version this function accepts validates its tabs the same way, so
  // the filter is shared rather than repeated per branch.
  const tabs = value.tabs.filter(isTab).map(normaliseTab)

  if (value.version === 4) {
    const v4 = value as Partial<PrcliConfig>
    const projects = Array.isArray(v4.projects) ? v4.projects.filter(isProject) : []
    return {
      version: 4,
      projects: projects.map(normaliseProject),
      activeProjectId: typeof v4.activeProjectId === 'string' ? v4.activeProjectId : null,
      tabs,
      notifications: normaliseNotifications(v4.notifications),
    }
  }
  if (value.version === 3) {
    const v3 = value as { projects?: unknown; activeProjectId?: unknown }
    const projects = Array.isArray(v3.projects) ? v3.projects.filter(isProject) : []
    return {
      version: 4,
      projects: projects.map(normaliseProject),
      activeProjectId: typeof v3.activeProjectId === 'string' ? v3.activeProjectId : null,
      tabs,
      notifications: DEFAULT_NOTIFICATIONS,
    }
  }
  if (value.version === 1 || value.version === 2) {
    return {
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs,
      notifications: DEFAULT_NOTIFICATIONS,
    }
  }
  // A version from the future: refuse to guess at its shape.
  return { ...EMPTY }
}
```

Add the imports this needs at the top of `store.ts`, alongside the existing `Preset` import:

```ts
import type { NotificationConfig, Preset, TabType } from '../../shared/ipc'

export type { Preset }
```

- [ ] **Step 5: Add `configRoot`**

Still in `src/main/state/store.ts`, add above the `ConfigStore` class:

```ts
/**
 * The directory `PRCLI_CONFIG_DIR` names, defaulting to `~/.prcli`.
 *
 * Exported because config.json is no longer the only thing that lives there:
 * the hook socket, the spool and the installed hook script are all siblings of
 * it, and every one of them must move with the escape hatch so a test never
 * reaches the real `~/.prcli`.
 */
export function configRoot(): string {
  return process.env.PRCLI_CONFIG_DIR ?? join(homedir(), '.prcli')
}
```

and rewrite `ConfigStore.defaultPath` to use it, so there is one definition of where the directory is:

```ts
  static defaultPath(): string {
    return join(configRoot(), 'config.json')
  }
```

- [ ] **Step 6: Add `type` to `TabRecord`**

In `src/main/sessions/manager.ts`, change the `TabRecord` interface. Task 9 wires the rest of the manager; this is only the type, so `store.ts` compiles:

```ts
export interface TabRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
  type: TabType
}
```

with the import:

```ts
import type { TabType } from '../../shared/ipc'
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/unit/store.test.ts`

Expected: PASS, including the six new cases.

**One existing assertion legitimately changes.** The test asserting `read()` resolves to `{ version: 3, activeProjectId: null, projects: [], tabs: [] }` for a config with bad project rows now resolves to a v4 object carrying `notifications`. Update it to the new shape — this is the schema change being visible, not an assertion being weakened, and the thing it actually tests (bad project rows are dropped) must still be asserted exactly as before. Any *other* existing test that fails, stop and report.

Then: `npm run typecheck`

Expected: **errors**, in `manager.ts`, `restore.ts` and `register.ts` — every place that builds a `TabRecord` now owes a `type`, and every place that writes a config now owes `notifications`. That is the change being visible rather than silent. Fix them:

- In `manager.ts`'s `open`, add `type: input.type ?? 'shell'` to the record it builds, and `type?: TabType` to `OpenInput`.
- In `manager.ts`'s `findOrphans`, add `type: 'shell'` to the synthesised record, with the comment: an adopted session's launch intent is not recoverable from its name, and `shell` is the type that claims least.
- In `manager.ts`'s `moveToProject`, thread `type: current.type` through the `open` call, so a moved tab keeps what it was.
- In `restore.ts`, add `type: record.type` to the `manager.open` call, and `notifications: saved.notifications` plus `version: 4` to the `store.write` call.

Run: `npm run typecheck && npm test && npm run lint`

Expected: all clean, 217 tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Take config to v4: tab type, notification rules, validated tabs

Three changes, one migration.

`type` declares what a tab was launched as. It drives the launch command
and the expecting-hooks dot and nothing else — it does not gate whether a
tab can have status, because the way this app is used is to open a tab
and type `claude` into it. A v3 row cannot say whether it was running
Claude and does not need to, so migration types by the only thing the
record knows: a tab with a command is a preset, one without is a shell.

The notifications block ships toast-on, sound-off. The parent spec names
Funk for waiting and Glass for idle, but this machine's settings.json
already plays exactly those two on Notification and Stop, so the spec's
defaults would double-fire them.

And tabs are now validated as elements, closing a carry-forward. `tabs:
[null]` survived read() and then crashed restore.ts on the dereference —
read()'s never-throws contract kept to the letter and broken one frame
later. A row missing only its optional type is normalised rather than
dropped: a live session is worth more than a correct type field.

configRoot() is exported because config.json is no longer the only thing
in that directory — the hook socket, spool and script are all siblings,
and all must move with PRCLI_CONFIG_DIR.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The state machine

Pure, no I/O, no tmux, no config. This is the unit that decides what every dot in the app says, so it gets an exhaustive table test rather than a representative one.

One thing to understand before writing it. The parent spec draws the state model as a graph with edges out of particular states, but the transition function is **memoryless**: each event names the state it implies, regardless of where the tab was. `Stop` means idle whether the tab was thinking or waiting; `UserPromptSubmit` means thinking whether it was idle or waiting. That satisfies the spec's rule — "any event other than `Notification` returns a waiting tab to `thinking`" — because every non-`Notification` event maps to something that is not `waiting`. Writing it as a lookup rather than a graph is not a simplification of the model; it is what the model turns out to be.

**Files:**
- Create: `src/main/status/machine.ts`
- Test: `tests/unit/machine.test.ts`

**Interfaces:**
- Consumes: `TabState` from `src/shared/status.ts`, `TabType` from `src/shared/ipc.ts`
- Produces:
  - `stateForHook(event: HookEvent): TabState`
  - `stateForExit(code: number): TabState`
  - `stateForOpen(type: TabType): TabState | null`

`HookEvent` itself is defined in Task 5's `protocol.ts`; this task defines it locally and Task 5 moves it. That ordering is deliberate — the machine is the thing worth testing first, and it should not wait on the wire format.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/machine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  HOOK_EVENTS,
  stateForExit,
  stateForHook,
  stateForOpen,
  type HookEvent,
} from '../../src/main/status/machine'
import { SEVERITY, type TabState } from '../../src/shared/status'

describe('stateForHook', () => {
  // The table, spelled out rather than generated. If one of these is wrong the
  // whole app lies about what a session is doing, and a generated expectation
  // would just restate the implementation.
  const table: Record<HookEvent, TabState> = {
    SessionStart: 'idle',
    UserPromptSubmit: 'thinking',
    PreToolUse: 'thinking',
    PostToolUse: 'thinking',
    Notification: 'waiting',
    Stop: 'idle',
    SessionEnd: 'unknown',
  }

  for (const [event, expected] of Object.entries(table)) {
    it(`maps ${event} to ${expected}`, () => {
      expect(stateForHook(event as HookEvent)).toBe(expected)
    })
  }

  it('has an entry for every subscribed event', () => {
    for (const event of HOOK_EVENTS) {
      expect(SEVERITY).toContain(stateForHook(event))
    }
    expect(Object.keys(table).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  // The rule from the parent spec, checked as a property rather than trusted:
  // Notification is the only way into `waiting`, so a tab cannot get stuck
  // there while Claude is working.
  it('reaches waiting only through Notification', () => {
    for (const event of HOOK_EVENTS) {
      if (event === 'Notification') continue
      expect(stateForHook(event)).not.toBe('waiting')
    }
  })
})

describe('stateForExit', () => {
  it('reads zero as a clean end', () => {
    expect(stateForExit(0)).toBe('ended')
  })

  it('reads anything else as a crash', () => {
    expect(stateForExit(1)).toBe('crashed')
    expect(stateForExit(130)).toBe('crashed')
    expect(stateForExit(-1)).toBe('crashed')
  })
})

describe('stateForOpen', () => {
  // A claude tab that has produced no events yet is the one case where a
  // hollow dot earns its place: it makes a broken hook install visible
  // instead of silent.
  it('starts a claude tab expecting hooks', () => {
    expect(stateForOpen('claude')).toBe('unknown')
  })

  it('starts a preset tab running', () => {
    expect(stateForOpen('preset')).toBe('running')
  })

  // Not `unknown`: a row of hollow dots on every shell trains you to ignore
  // the affordance the milestone needs you to trust. A shell gets a dot only
  // once something in it has said something.
  it('gives a shell tab no state at all', () => {
    expect(stateForOpen('shell')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/machine.test.ts`

Expected: FAIL — cannot resolve `../../src/main/status/machine`.

- [ ] **Step 3: Write the machine**

Create `src/main/status/machine.ts`:

```ts
import type { TabType } from '../../shared/ipc'
import type { TabState } from '../../shared/status'

/**
 * The Claude Code hook events PRCLI subscribes to.
 *
 * Each one is registered as its own entry in settings.json and passes its own
 * name as the hook script's argument, so the script never parses a payload.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * The state an event implies — regardless of the state the tab was in.
 *
 * The parent spec draws this as a graph, but it resolves to a lookup: every
 * event names the state it means. `Stop` is idle whether the tab was thinking
 * or waiting; `UserPromptSubmit` is thinking whether it was idle or waiting.
 * That is exactly the spec's rule that any event other than `Notification`
 * returns a waiting tab to `thinking` — no non-Notification event maps to
 * `waiting`, so the property holds by construction rather than by a branch.
 *
 * `Notification` fires both for a permission prompt and after roughly sixty
 * seconds idle at the input. Both genuinely mean *you are the blocker*, so
 * both are correctly `waiting`. This looks like a bug the first time it is
 * read, which is why it is written down.
 *
 * `SessionEnd` returns the tab to `unknown` rather than `idle`: Claude is gone
 * and the tab is a shell again, and claiming to know its state would be a
 * guess. The next `claude` in that tab starts the cycle over.
 */
export function stateForHook(event: HookEvent): TabState {
  switch (event) {
    case 'SessionStart':
    case 'Stop':
      return 'idle'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'thinking'
    case 'Notification':
      return 'waiting'
    case 'SessionEnd':
      return 'unknown'
  }
}

/** A dead session's parting word. Non-zero is a crash worth a red dot. */
export function stateForExit(code: number): TabState {
  return code === 0 ? 'ended' : 'crashed'
}

/**
 * The state a freshly opened tab starts in, or null for no dot at all.
 *
 * A `claude` tab starts `unknown` so that a broken hook install shows as a
 * hollow dot rather than as nothing. A `shell` starts with no state, because a
 * dot on every shell is a row of hollow dots that trains you to ignore the
 * affordance this milestone needs you to trust — it gets one the moment
 * something in it speaks.
 */
export function stateForOpen(type: TabType): TabState | null {
  switch (type) {
    case 'claude':
      return 'unknown'
    case 'preset':
      return 'running'
    case 'shell':
      return null
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/machine.test.ts`

Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/status/machine.ts tests/unit/machine.test.ts
git commit -m "$(cat <<'EOF'
Decide what a session is doing, from its events alone

Pure: no I/O, no tmux, no config. Every dot in the app says what this
module says, so the test is the whole table rather than a sample of it.

The parent spec draws the state model as a graph with edges out of
particular states. It resolves to a lookup — every event names the state
it implies, whatever the tab was in. That is not a simplification of the
model: the spec's rule that any event other than Notification returns a
waiting tab to thinking then holds by construction, because no
non-Notification event maps to waiting. A property test asserts it
rather than a comment claiming it.

Notification means waiting both times it fires — for a permission prompt
and after ~60s idle at the input. Both mean you are the blocker. Written
down because it reads like a bug.

A shell tab starts with no state rather than `unknown`. A hollow dot on
every shell is the row of hollow dots 2b refused to ship, for the same
reason: it trains you to ignore the affordance this milestone needs you
to trust.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The wire format

One tiny module holding what a hook event looks like on the socket and how to read one safely. Separated from the server because the spool parses the same lines from a file, and two parsers for one format is two chances to disagree about what a valid event is.

This is the app's only untrusted input. Anything on the machine that can open the socket can write to it, so the parser refuses everything it does not positively recognise rather than accepting anything it cannot disprove.

**Files:**
- Create: `src/main/hooks/protocol.ts`
- Modify: `src/main/status/machine.ts` (move `HOOK_EVENTS` here, re-export)
- Test: `tests/unit/protocol.test.ts`

**Interfaces:**
- Consumes: `HookEvent`, `HOOK_EVENTS` from Task 4
- Produces:
  - `interface HookEventMessage { tabId: string; event: HookEvent; at: number }`
  - `parseHookLine(line: string): HookEventMessage | null`
  - `formatHookLine(message: HookEventMessage): string`
  - `MAX_LINE_BYTES = 512`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatHookLine, parseHookLine, MAX_LINE_BYTES } from '../../src/main/hooks/protocol'

const ID = '0123456789abcdef'

describe('parseHookLine', () => {
  it('reads a well-formed line', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","at":1700000000000}`)).toEqual({
      tabId: ID,
      event: 'Stop',
      at: 1700000000000,
    })
  })

  it('round-trips what formatHookLine writes', () => {
    const message = { tabId: ID, event: 'Notification' as const, at: 42 }
    expect(parseHookLine(formatHookLine(message))).toEqual(message)
  })

  it('tolerates trailing whitespace and a carriage return', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","at":1}\r`)?.event).toBe('Stop')
  })

  // Everything below must return null rather than throw. This is the app's
  // only untrusted input: the socket is reachable by anything on the machine
  // that can open it, so the parser refuses what it does not recognise
  // instead of accepting what it cannot disprove.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not json', 'hello'],
    ['truncated json', `{"tabId":"${ID}"`],
    ['an array', '[]'],
    ['a bare string', '"nope"'],
    ['null', 'null'],
    ['a tab id that is not 16 hex', '{"tabId":"zzz","event":"Stop","at":1}'],
    ['a tab id of the wrong length', '{"tabId":"abc","event":"Stop","at":1}'],
    ['an uppercase tab id', '{"tabId":"0123456789ABCDEF","event":"Stop","at":1}'],
    ['an unknown event', `{"tabId":"${ID}","event":"Whatever","at":1}`],
    ['an event that is not a string', `{"tabId":"${ID}","event":7,"at":1}`],
    ['a missing timestamp', `{"tabId":"${ID}","event":"Stop"}`],
    ['a timestamp that is not a number', `{"tabId":"${ID}","event":"Stop","at":"soon"}`],
    ['a NaN timestamp', `{"tabId":"${ID}","event":"Stop","at":null}`],
  ])('refuses %s', (_label, line) => {
    expect(parseHookLine(line)).toBeNull()
  })

  it('refuses a line longer than the cap without parsing it', () => {
    const padded = `{"tabId":"${ID}","event":"Stop","at":1,"junk":"${'x'.repeat(MAX_LINE_BYTES)}"}`
    expect(parseHookLine(padded)).toBeNull()
  })

  it('ignores extra fields on an otherwise valid line', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","at":1,"extra":true}`)).toEqual({
      tabId: ID,
      event: 'Stop',
      at: 1,
    })
  })
})

describe('formatHookLine', () => {
  it('writes exactly one line', () => {
    const line = formatHookLine({ tabId: ID, event: 'Stop', at: 1 })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/protocol.test.ts`

Expected: FAIL — cannot resolve `../../src/main/hooks/protocol`.

- [ ] **Step 3: Write the protocol**

Create `src/main/hooks/protocol.ts`:

```ts
import { HOOK_EVENTS, type HookEvent } from '../status/machine'

export interface HookEventMessage {
  /** The tab the event came from — the id half of its tmux session name. */
  tabId: string
  event: HookEvent
  /** Epoch milliseconds, stamped by the hook script. */
  at: number
}

/**
 * A generous ceiling for a record of three short fields. Its job is to stop a
 * malformed or hostile write from becoming an unbounded allocation, not to
 * police the format — the parser does that.
 */
export const MAX_LINE_BYTES = 512

const TAB_ID_RE = /^[0-9a-f]{16}$/

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * Read one line from the socket or the spool, or return null.
 *
 * Never throws. This is the app's only untrusted input: the socket is
 * reachable by anything on the machine that can open it, and the spool is a
 * plain file anyone can append to. So this refuses everything it does not
 * positively recognise rather than accepting everything it cannot disprove —
 * and a rejected line is dropped silently, because a malformed write is not
 * something the user did and not something they can act on.
 */
export function parseHookLine(line: string): HookEventMessage | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return null
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const candidate = value as { tabId?: unknown; event?: unknown; at?: unknown }
  if (typeof candidate.tabId !== 'string' || !TAB_ID_RE.test(candidate.tabId)) return null
  if (!isHookEvent(candidate.event)) return null
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null

  return { tabId: candidate.tabId, event: candidate.event, at: candidate.at }
}

/** The exact bytes the hook script writes. Kept here so the two cannot drift. */
export function formatHookLine(message: HookEventMessage): string {
  return `${JSON.stringify({ tabId: message.tabId, event: message.event, at: message.at })}\n`
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/protocol.test.ts`

Expected: PASS, 20 tests.

- [ ] **Step 5: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/hooks/protocol.ts tests/unit/protocol.test.ts
git commit -m "$(cat <<'EOF'
Define the hook wire format once

The socket and the spool carry the same lines, so they parse them with
the same function. Two parsers for one format is two chances to disagree
about what a valid event is.

This is the app's only untrusted input — anything on the machine that
can open the socket can write to it, and the spool is a plain file
anyone can append to. So the parser refuses what it does not positively
recognise rather than accepting what it cannot disprove: a 16-hex tab
id, an event from the subscribed set, a finite number for the timestamp,
and a byte cap checked before JSON.parse ever sees the string.

A rejected line is dropped silently. A malformed write is not something
the user did and not something they can act on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Merging into `~/.claude/settings.json`

The highest-blast-radius change in the milestone. This file is read by every live Claude session on this machine, and a bad merge breaks all of them at once.

**Inspected before writing this plan, so the fixture is not invented.** The real file holds twelve top-level keys (`env`, `permissions`, `model`, `hooks`, `statusLine`, `enabledPlugins`, `extraKnownMarketplaces`, `tui`, and four booleans) and already populates five of the seven events PRCLI subscribes to. `PreToolUse` carries a `matcher: "Bash"` entry. `SessionStart` and `Stop` each hold **multiple** groups. So the merge appends one group to an event's array and edits no existing element, ever.

Pure functions only in this task — no file writing. `installHooks` lands in Task 11, where it has a config directory to write the script into. Keeping the merge pure is what lets the install screen show the user exactly the bytes that will be written, from the same call that writes them.

**Files:**
- Create: `src/main/hooks/install.ts`
- Test: `tests/unit/install.test.ts`

**Interfaces:**
- Consumes: `HOOK_EVENTS` from `src/main/status/machine.ts`
- Produces:
  - `claudeSettingsPath(): string`
  - `hookCommand(hookPath: string, event: HookEvent): string`
  - `merge(settings: unknown, hookPath: string): { next: ClaudeSettings; added: HookEvent[] }`
  - `unmerge(settings: unknown, hookPath: string): { next: ClaudeSettings; removed: HookEvent[] }`
  - `isInstalled(settings: unknown, hookPath: string): boolean`
  - `soundCollisions(settings: unknown): { event: string; command: string }[]`
  - `type ClaudeSettings = Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/install.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  hookCommand,
  isInstalled,
  merge,
  soundCollisions,
  unmerge,
} from '../../src/main/hooks/install'
import { HOOK_EVENTS } from '../../src/main/status/machine'

const HOOK = '/Users/someone/.prcli/bin/prcli-hook'

/**
 * Modelled on the real ~/.claude/settings.json, not invented: twelve
 * top-level keys, five of the seven subscribed events already populated, a
 * matcher on PreToolUse, and two events holding more than one group. Those
 * are the four shapes the merge must not disturb.
 */
function realistic(): Record<string, unknown> {
  return {
    env: { SOME_KEY: 'value' },
    permissions: { allow: ['Bash(ls:*)'] },
    model: 'opusplan',
    statusLine: { type: 'command', command: 'statusline.sh' },
    enabledPlugins: { 'superpowers@obra': true },
    tui: { theme: 'dark' },
    skipDangerousModePermissionPrompt: true,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/someone/.claude/guard.sh' }] },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node "/Users/someone/.claude/update.js"' }] },
        { hooks: [{ type: 'command', command: '/Users/someone/.claude/session-update' }] },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'node "/Users/someone/.claude/monitor.js"' }] },
      ],
      Notification: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Funk.aiff' }] }],
      Stop: [
        { hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] },
        { hooks: [{ type: 'command', command: '/Users/someone/.claude/stop.sh' }] },
      ],
    },
  }
}

describe('merge', () => {
  it('adds an entry for every subscribed event', () => {
    const { next, added } = merge(realistic(), HOOK)

    expect([...added].sort()).toEqual([...HOOK_EVENTS].sort())
    const hooks = next.hooks as Record<string, unknown[]>
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event] ?? []
      const commands = groups.flatMap((group) =>
        ((group as { hooks?: { command?: string }[] }).hooks ?? []).map((h) => h.command),
      )
      expect(commands).toContain(hookCommand(HOOK, event))
    }
  })

  it('leaves every pre-existing group byte-identical', () => {
    const before = realistic()
    const { next } = merge(before, HOOK)

    const beforeHooks = before.hooks as Record<string, unknown[]>
    const afterHooks = next.hooks as Record<string, unknown[]>
    for (const [event, groups] of Object.entries(beforeHooks)) {
      // PRCLI appends, so the originals must still be the leading elements in
      // the same order — a matcher intact, two groups still two groups.
      expect(afterHooks[event]?.slice(0, groups.length)).toEqual(groups)
    }
  })

  it('leaves every other top-level key untouched', () => {
    const before = realistic()
    const { next } = merge(before, HOOK)

    for (const key of Object.keys(before)) {
      if (key === 'hooks') continue
      expect(next[key]).toEqual(before[key])
    }
  })

  it('does not mutate the settings it was given', () => {
    const before = realistic()
    const snapshot = JSON.parse(JSON.stringify(before))
    merge(before, HOOK)
    expect(before).toEqual(snapshot)
  })

  it('is idempotent — a second merge adds nothing', () => {
    const once = merge(realistic(), HOOK)
    const twice = merge(once.next, HOOK)

    expect(twice.added).toEqual([])
    expect(twice.next).toEqual(once.next)
  })

  it('builds a hooks block from nothing when the file has none', () => {
    const { next, added } = merge({ model: 'opusplan' }, HOOK)

    expect(added).toHaveLength(HOOK_EVENTS.length)
    expect(next.model).toBe('opusplan')
    expect(Object.keys(next.hooks as object).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  it('treats a settings file that is not an object as an empty one', () => {
    expect(merge(null, HOOK).added).toHaveLength(HOOK_EVENTS.length)
    expect(merge('nonsense', HOOK).added).toHaveLength(HOOK_EVENTS.length)
    expect(merge([], HOOK).added).toHaveLength(HOOK_EVENTS.length)
  })

  it("gives PRCLI's PreToolUse entry no matcher, so it sees every tool", () => {
    const { next } = merge(realistic(), HOOK)
    const groups = (next.hooks as Record<string, Record<string, unknown>[]>).PreToolUse ?? []
    const ours = groups.find((group) =>
      ((group.hooks ?? []) as { command?: string }[]).some(
        (h) => h.command === hookCommand(HOOK, 'PreToolUse'),
      ),
    )
    expect(ours).toBeDefined()
    expect(ours && 'matcher' in ours).toBe(false)
  })
})

describe('isInstalled', () => {
  it('is false before and true after', () => {
    expect(isInstalled(realistic(), HOOK)).toBe(false)
    expect(isInstalled(merge(realistic(), HOOK).next, HOOK)).toBe(true)
  })

  it('is false when only some events carry our entry', () => {
    const { next } = merge(realistic(), HOOK)
    const hooks = next.hooks as Record<string, unknown[]>
    delete hooks.Stop
    expect(isInstalled(next, HOOK)).toBe(false)
  })

  it('does not mistake another tool\'s hook for ours', () => {
    expect(isInstalled(realistic(), HOOK)).toBe(false)
  })
})

describe('unmerge', () => {
  it('removes exactly what merge added', () => {
    const before = realistic()
    const { next } = merge(before, HOOK)
    const { next: after, removed } = unmerge(next, HOOK)

    expect([...removed].sort()).toEqual([...HOOK_EVENTS].sort())
    expect(after).toEqual(before)
  })

  it('leaves an event array in place when something else is still in it', () => {
    const { next } = merge(realistic(), HOOK)
    const after = unmerge(next, HOOK).next
    const hooks = after.hooks as Record<string, unknown[]>
    expect(hooks.Stop).toHaveLength(2)
    expect(hooks.SessionStart).toHaveLength(2)
  })

  it('drops an event key entirely when ours was the only group in it', () => {
    const { next } = merge({ model: 'x' }, HOOK)
    const after = unmerge(next, HOOK).next
    // Leaving `SessionEnd: []` behind would be litter in a file the user reads.
    expect(after.hooks).toBeUndefined()
  })

  it('removes nothing when nothing of ours is there', () => {
    const before = realistic()
    const { next, removed } = unmerge(before, HOOK)
    expect(removed).toEqual([])
    expect(next).toEqual(before)
  })

  it('removes only the hook path it was given', () => {
    const other = '/Users/someone/.prcli-other/bin/prcli-hook'
    const both = merge(merge(realistic(), HOOK).next, other).next
    const after = unmerge(both, HOOK).next
    expect(isInstalled(after, HOOK)).toBe(false)
    expect(isInstalled(after, other)).toBe(true)
  })
})

describe('soundCollisions', () => {
  // This machine already plays Funk on Notification and Glass on Stop — two of
  // the three sounds the parent spec's default rules name. The install screen
  // names the collision rather than letting it be discovered by ear.
  it('finds afplay hooks on subscribed events', () => {
    const found = soundCollisions(realistic())
    expect(found.map((c) => c.event).sort()).toEqual(['Notification', 'Stop'])
    expect(found[0]?.command).toContain('afplay')
  })

  it('ignores afplay on an event PRCLI does not subscribe to', () => {
    const settings = { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'afplay x' }] }] } }
    expect(soundCollisions(settings)).toEqual([])
  })

  it('finds nothing in a file with no hooks', () => {
    expect(soundCollisions({ model: 'x' })).toEqual([])
    expect(soundCollisions(null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/install.test.ts`

Expected: FAIL — cannot resolve `../../src/main/hooks/install`.

- [ ] **Step 3: Write the merge**

Create `src/main/hooks/install.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS, type HookEvent } from '../status/machine'

export type ClaudeSettings = Record<string, unknown>

/** One group in an event's array, as Claude Code reads it. */
interface HookGroup {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

/**
 * `PRCLI_CLAUDE_SETTINGS` exists for the same reason `PRCLI_CONFIG_DIR` does,
 * and matters more: this file is read by every live Claude session on the
 * machine, so a test that wrote the real one could break work in progress in
 * a dozen windows at once.
 */
export function claudeSettingsPath(): string {
  return process.env.PRCLI_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
}

/**
 * What goes in `command` for one event.
 *
 * The event name is an argument rather than something parsed out of stdin:
 * PostToolUse payloads carry tool output and can be large, and the state
 * machine needs the name and nothing else. The path is quoted because a home
 * directory may contain spaces.
 */
export function hookCommand(hookPath: string, event: HookEvent): string {
  return `"${hookPath}" ${event}`
}

function asSettings(value: unknown): ClaudeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as ClaudeSettings
}

function hooksOf(settings: ClaudeSettings): Record<string, HookGroup[]> {
  const hooks = settings.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return {}
  const out: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(groups)) out[event] = groups as HookGroup[]
  }
  return out
}

function isOurs(group: HookGroup, hookPath: string): boolean {
  return (group.hooks ?? []).some((hook) => hook.command === undefined
    ? false
    : hook.command.startsWith(`"${hookPath}"`))
}

/**
 * Append PRCLI's entry to every subscribed event, touching nothing else.
 *
 * Appending is the whole design. The real file holds five of these seven
 * events already: one carries a `matcher`, two hold more than one group, and
 * every one of them belongs to something the user installed on purpose. So
 * this adds an element to an array and never edits, reorders or replaces one.
 *
 * PRCLI's own `PreToolUse` group carries no matcher, so it fires for every
 * tool rather than for the one the neighbouring entry happens to filter on.
 *
 * Pure, and non-mutating: the install screen renders the diff from this call
 * and the writer writes the result of the same call, so the two cannot
 * disagree about what is about to happen.
 */
export function merge(
  settings: unknown,
  hookPath: string,
): { next: ClaudeSettings; added: HookEvent[] } {
  const base = asSettings(settings)
  const hooks = hooksOf(base)
  const nextHooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(hooks)) nextHooks[event] = [...groups]

  const added: HookEvent[] = []
  for (const event of HOOK_EVENTS) {
    const groups = nextHooks[event] ?? []
    if (groups.some((group) => isOurs(group, hookPath))) continue
    groups.push({ hooks: [{ type: 'command', command: hookCommand(hookPath, event) }] })
    nextHooks[event] = groups
    added.push(event)
  }

  return { next: { ...base, hooks: nextHooks }, added }
}

/** Whether every subscribed event already carries this hook path. */
export function isInstalled(settings: unknown, hookPath: string): boolean {
  const hooks = hooksOf(asSettings(settings))
  return HOOK_EVENTS.every((event) =>
    (hooks[event] ?? []).some((group) => isOurs(group, hookPath)),
  )
}

/**
 * Remove only PRCLI's own groups.
 *
 * An event whose array still holds someone else's hook keeps the array; an
 * event where ours was the only group loses the key, because `SessionEnd: []`
 * left behind is litter in a file the user reads by hand. If nothing is left
 * at all the `hooks` key goes too, so uninstall restores the file it found.
 */
export function unmerge(
  settings: unknown,
  hookPath: string,
): { next: ClaudeSettings; removed: HookEvent[] } {
  const base = asSettings(settings)
  const hooks = hooksOf(base)
  const nextHooks: Record<string, HookGroup[]> = {}
  const removed: HookEvent[] = []

  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.filter((group) => !isOurs(group, hookPath))
    if (kept.length !== groups.length && (HOOK_EVENTS as readonly string[]).includes(event)) {
      removed.push(event as HookEvent)
    }
    if (kept.length > 0) nextHooks[event] = kept
  }

  const next: ClaudeSettings = { ...base }
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks
  else delete next.hooks
  return { next, removed }
}

/**
 * Existing `afplay` hooks on events PRCLI subscribes to.
 *
 * Not a problem to fix, a fact to show. This machine already plays Funk on
 * Notification and Glass on Stop, which are two of the three sounds the parent
 * spec's default rules name — so PRCLI's defaults ship silent and the install
 * screen says why, rather than leaving it to be discovered by ear.
 */
export function soundCollisions(settings: unknown): { event: string; command: string }[] {
  const hooks = hooksOf(asSettings(settings))
  const found: { event: string; command: string }[] = []
  for (const event of HOOK_EVENTS) {
    for (const group of hooks[event] ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.command?.includes('afplay')) found.push({ event, command: hook.command })
      }
    }
  }
  return found
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/install.test.ts`

Expected: PASS, 21 tests.

- [ ] **Step 5: Prove the fixture matches reality**

This is the one task where the fixture being wrong makes every test worthless. Check the real file's *shape* without writing to it and without putting its contents in your report:

Run:

```bash
node -e "
const fs=require('fs'), os=require('os');
const p=os.homedir()+'/.claude/settings.json';
try{
  const j=JSON.parse(fs.readFileSync(p,'utf8'));
  const h=j.hooks||{};
  console.log('top-level keys:', Object.keys(j).length);
  for(const [k,v] of Object.entries(h))
    console.log(' ', k, 'groups:', Array.isArray(v)?v.length:'?',
      'matchers:', Array.isArray(v)?v.filter(g=>g&&g.matcher).length:'?');
}catch(e){console.log('unreadable:', e.message)}
"
```

Confirm in your report that the real file still has: more than one top-level key beyond `hooks`, at least one event with more than one group, and at least one group carrying a `matcher`. If any of those is no longer true, say so — the fixture is a model of this file and a model that has drifted is worth knowing about. **Do not modify the file.**

- [ ] **Step 6: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/hooks/install.ts tests/unit/install.test.ts
git commit -m "$(cat <<'EOF'
Merge into ~/.claude/settings.json without disturbing it

The highest-blast-radius change in the milestone: this file is read by
every live Claude session on the machine, and a bad merge breaks all of
them at once.

The fixture is modelled on the real file rather than invented. That file
holds twelve top-level keys, already populates five of the seven events
PRCLI subscribes to, carries a matcher on PreToolUse, and holds multiple
groups under SessionStart and Stop. Those are the four shapes the merge
must not disturb, and each has a test asserting it survives byte-identical.

So merge appends one group to an event's array and never edits, reorders
or replaces an existing element. PRCLI's own PreToolUse group carries no
matcher, so it sees every tool rather than the one a neighbouring entry
happens to filter on. Unmerge removes only groups whose command starts
with the hook path it was given, keeps an array that still holds someone
else's hook, and drops the key when ours was the only thing in it.

All pure, and non-mutating. The install screen renders the diff from the
same call that produces the bytes written, so the preview and the write
cannot disagree.

soundCollisions reports existing afplay hooks on subscribed events. Not a
problem to fix — a fact to show, since the shipped rules are silent
precisely because this machine already plays Funk and Glass.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The hook script

Twelve lines of POSIX shell that must never block Claude and never fail it. Everything unusual about this file was probed on this machine before the plan was written — do not "simplify" any of it back:

- `/usr/bin/nc` supports `-U` and delivers to a Node `net` Unix socket correctly.
- Apple's `nc` has **no `-q`** (`nc: invalid option -- q`), and its `-N` means "number of probes", not "shutdown on EOF" — passing `-N -U` fails with `invalid tcp adaptive write timeout value` and sends nothing.
- It does **not** exit when the server closes the connection. Measured: a foreground write with the server calling `end()` immediately still hung until the harness timed out at 4s. With `-w 1` it exits — after a measured **1012ms**.
- Backgrounding the write returns control in a measured **3ms**, with the line confirmed received.

A hook costing a second, seven times a turn, across twelve sessions is not acceptable, and `PreToolUse` blocks Claude while it runs. Hence the background subshell.

The redirection on that subshell is load-bearing too: Claude reads the hook's stdout, and a background child inheriting it would hold the pipe open after the parent exits.

**Files:**
- Modify: `src/main/hooks/install.ts`
- Test: `tests/integration/hook-script.test.ts`

**Interfaces:**
- Consumes: `configRoot()` from `src/main/state/store.ts`
- Produces:
  - `hookPaths(): { dir: string; script: string; socket: string; spool: string }`
  - `renderScript(paths: { socket: string; spool: string }): string`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/hook-script.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderScript } from '../../src/main/hooks/install'
import { parseHookLine } from '../../src/main/hooks/protocol'

const ID = '0123456789abcdef'

let dir: string
let server: Server | null = null

/** Write the rendered script to a temp dir and make it executable. */
async function install(): Promise<{ script: string; socket: string; spool: string }> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-hook-'))
  const paths = { script: join(dir, 'prcli-hook'), socket: join(dir, 'h.sock'), spool: join(dir, 'h.spool') }
  await writeFile(paths.script, renderScript(paths), 'utf8')
  await chmod(paths.script, 0o755)
  return paths
}

/** Run the script the way Claude does: argv[1] is the event name. */
function runHook(
  script: string,
  event: string,
  tabId: string | undefined,
): Promise<{ ms: number; stdout: string; code: number }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    execFile(
      script,
      [event],
      {
        timeout: 5_000,
        env: tabId === undefined ? { PATH: process.env.PATH ?? '' } : { PATH: process.env.PATH ?? '', PRCLI_TAB_ID: tabId },
      },
      (error, stdout) => {
        if (error && typeof error.code !== 'number') return reject(error)
        resolve({ ms: Date.now() - started, stdout, code: typeof error?.code === 'number' ? error.code : 0 })
      },
    )
  })
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  await rm(dir, { recursive: true, force: true })
})

describe('prcli-hook', () => {
  it('delivers a line to a listening socket', async () => {
    const paths = await install()
    const received: string[] = []
    server = createServer((connection) => {
      connection.on('data', (chunk) => received.push(String(chunk)))
    })
    await new Promise<void>((resolve) => server?.listen(paths.socket, resolve))

    await runHook(paths.script, 'Notification', ID)

    await expect
      .poll(() => received.length, { timeout: 4_000 })
      .toBeGreaterThan(0)
    const message = parseHookLine(received.join(''))
    expect(message).toEqual({ tabId: ID, event: 'Notification', at: expect.any(Number) })
  })

  // The measured reason the write is backgrounded. Apple's nc does not exit
  // when the server closes, so a foreground write costs ~1s with -w 1 and
  // hangs without it — seven times a turn, across twelve sessions, with
  // PreToolUse blocking Claude while it runs.
  it('returns in milliseconds, not seconds, even with a server that never replies', async () => {
    const paths = await install()
    server = createServer(() => {
      // Accept and say nothing at all.
    })
    await new Promise<void>((resolve) => server?.listen(paths.socket, resolve))

    const { ms, code } = await runHook(paths.script, 'Stop', ID)

    expect(code).toBe(0)
    expect(ms).toBeLessThan(500)
  })

  it('exits 0 and spools when nothing is listening', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', ID)

    expect(code).toBe(0)
    await expect
      .poll(async () => {
        try {
          return (await readFile(paths.spool, 'utf8')).length
        } catch {
          return 0
        }
      }, { timeout: 4_000 })
      .toBeGreaterThan(0)
    const spooled = parseHookLine((await readFile(paths.spool, 'utf8')).trim())
    expect(spooled?.event).toBe('Stop')
  })

  it('appends rather than overwriting, so concurrent hooks do not lose each other', async () => {
    const paths = await install()

    await Promise.all([
      runHook(paths.script, 'Stop', ID),
      runHook(paths.script, 'Notification', ID),
      runHook(paths.script, 'PreToolUse', ID),
    ])

    await expect
      .poll(async () => {
        try {
          return (await readFile(paths.spool, 'utf8')).trim().split('\n').filter(Boolean).length
        } catch {
          return 0
        }
      }, { timeout: 4_000 })
      .toBe(3)
  })

  it('writes nothing at all when the tab id is absent', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', undefined)

    expect(code).toBe(0)
    // A Claude session started outside PRCLI fires these too. It must cost
    // nothing and leave nothing behind.
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  it('writes nothing when the tab id is not a tab id', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', 'not-a-tab-id"; rm -rf /')

    expect(code).toBe(0)
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  it('produces no output, so Claude sees nothing on stdout', async () => {
    const paths = await install()

    const { stdout } = await runHook(paths.script, 'Stop', ID)

    expect(stdout).toBe('')
  })

  it('refuses to render against a path that would break the quoting', () => {
    expect(() => renderScript({ socket: '/tmp/a"b/h.sock', spool: '/tmp/h.spool' })).toThrow()
    expect(() => renderScript({ socket: '/tmp/h.sock', spool: '/tmp/$HOME/h.spool' })).toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/hook-script.test.ts`

Expected: FAIL — `renderScript` is not exported from `install.ts`.

- [ ] **Step 3: Write the renderer and the paths**

Add to `src/main/hooks/install.ts`:

```ts
import { configRoot } from '../state/store'

/**
 * Everything the hook bridge keeps on disk, all of it under `configRoot()` so
 * that `PRCLI_CONFIG_DIR` moves the socket, the spool and the script together
 * and a test can never reach the real `~/.prcli`.
 */
export function hookPaths(): { dir: string; script: string; socket: string; spool: string } {
  const dir = configRoot()
  return {
    dir,
    script: join(dir, 'bin', 'prcli-hook'),
    socket: join(dir, 'hook.sock'),
    spool: join(dir, 'hook.spool'),
  }
}

/**
 * Anything that would change meaning inside a double-quoted shell string.
 * These paths come from `configRoot()`, so this should never fire — but the
 * failure it prevents is arbitrary shell execution in a file that runs on
 * every Claude event, which is worth a guard rather than an assumption.
 */
const UNSAFE_IN_PATH = /["$`\\\n]/

/**
 * The installed hook script.
 *
 * Every unusual line here was measured on macOS before it was written down.
 *
 * - Apple's `nc` has no `-q`, and its `-N` means "number of probes" — passing
 *   `-N -U` errors out and sends nothing.
 * - It does not exit when the server closes the connection. A foreground write
 *   hung until the harness gave up at 4s; with `-w 1` it exits after ~1012ms.
 * - Backgrounding the write returns in ~3ms with the line confirmed received.
 *
 * So the write is backgrounded. A hook costing a second, seven times a turn,
 * across twelve sessions is not acceptable, and `PreToolUse` blocks Claude
 * while it runs.
 *
 * The redirection on the subshell is not tidiness: Claude reads this script's
 * stdout, and a background child inheriting it would hold the pipe open after
 * the parent has exited. `-w 2` bounds a wedged server. The `||` fallback sits
 * inside the same subshell, so a failed write still spools without the
 * foreground waiting to learn that it failed.
 *
 * The tab id is validated before it reaches the line: it is our own 16-hex id,
 * but the environment is not ours to trust, and this is the one place where an
 * unchecked value would be interpolated into both JSON and a shell string.
 */
export function renderScript(paths: { socket: string; spool: string }): string {
  for (const path of [paths.socket, paths.spool]) {
    if (UNSAFE_IN_PATH.test(path)) {
      throw new Error(`renderScript: refusing to embed unsafe path ${JSON.stringify(path)}`)
    }
  }
  return [
    '#!/bin/sh',
    '# PRCLI hook — installed by PRCLI. Edits here are overwritten on reinstall.',
    '#',
    '# Never blocks Claude and never fails it: exits 0 on every path, writes',
    '# nothing to stdout, and hands the socket write to a background subshell',
    "# because Apple's nc does not exit when the server closes.",
    '',
    '# Not a PRCLI tab — a Claude session started outside the app. Cost nothing.',
    '[ -n "$PRCLI_TAB_ID" ] || exit 0',
    '',
    '# Our ids are 16 hex characters. The environment is not ours to trust, and',
    '# this value is about to be interpolated into JSON and a shell string.',
    'case "$PRCLI_TAB_ID" in',
    '  *[!0-9a-f]*) exit 0 ;;',
    'esac',
    '',
    'event=${1:-Unknown}',
    'line="{\\"tabId\\":\\"$PRCLI_TAB_ID\\",\\"event\\":\\"$event\\",\\"at\\":$(($(date +%s) * 1000))}"',
    '',
    '{',
    `  printf '%s\\n' "$line" | /usr/bin/nc -U -w 2 "${paths.socket}" ||`,
    `    printf '%s\\n' "$line" >> "${paths.spool}"`,
    '} >/dev/null 2>&1 &',
    '',
    'exit 0',
    '',
  ].join('\n')
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/hook-script.test.ts`

Expected: PASS, 8 tests.

If the timing assertion is flaky on a loaded machine, report the numbers you actually see rather than raising the threshold. 500ms against a measured 3ms is three orders of magnitude of headroom; if that is not enough, something is wrong with the script, not with the test.

- [ ] **Step 5: Read the rendered script yourself**

The tests exercise behaviour; this checks it is a file a human would not be alarmed to find in their home directory.

Run:

```bash
node -e "
require('esbuild-register/dist/node').register?.();
" 2>/dev/null || true
npx vitest run tests/integration/hook-script.test.ts --reporter=verbose
```

Then print it directly:

```bash
node --experimental-strip-types -e "
import('./src/main/hooks/install.ts').then(m =>
  console.log(m.renderScript({ socket: '/Users/you/.prcli/hook.sock', spool: '/Users/you/.prcli/hook.spool' })))
"
```

Check by eye: a shebang, the comment explaining why the write is backgrounded, no stray `$` that shell would expand at install time rather than run time, and `exit 0` as the last statement. Paste it into your report.

If `--experimental-strip-types` is unavailable on this Node, run the same thing through `npx tsx` instead, and say which you used.

- [ ] **Step 6: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/hooks/install.ts tests/integration/hook-script.test.ts
git commit -m "$(cat <<'EOF'
Render a hook script that cannot block Claude

Twelve lines of POSIX shell, and every unusual line in it was measured
on this machine rather than assumed.

Apple's nc has no -q, and its -N means "number of probes" — passing -N
-U errors and sends nothing. It does not exit when the server closes the
connection: a foreground write hung until the harness gave up at 4s, and
with -w 1 it exits after ~1012ms. Backgrounding the write returns in
~3ms with the line confirmed received.

So the write is backgrounded. A hook costing a second, seven times a
turn, across twelve sessions is not acceptable, and PreToolUse blocks
Claude while it runs. The test asserts the script returns in under 500ms
against a server that accepts and never replies — three orders of
magnitude of headroom over the measurement.

The redirection on the subshell is load-bearing, not tidiness: Claude
reads this script's stdout, and a background child inheriting it would
hold the pipe open after the parent exited.

The tab id is validated against 16 hex before it reaches the line. It is
our own id, but the environment is not ours to trust, and this is the
one place a value gets interpolated into both JSON and a shell string.
renderScript refuses paths containing anything that would change meaning
inside double quotes — those paths come from configRoot() and this
should never fire, but the failure it prevents is arbitrary execution in
a file that runs on every Claude event.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The socket server

Listens on `<configDir>/hook.sock`, parses one line per event through Task 5's parser, and emits. It holds no state and decides nothing — the registry in Task 11 does that — so this is testable against a raw socket with no app around it.

Two macOS specifics that are not optional:

- `sun_path` is capped near 104 bytes. A deep `PRCLI_CONFIG_DIR` — entirely plausible under a temp directory in CI — fails as a bare `EINVAL` with nothing saying why. Check the length and say so.
- A Unix socket file outlives the process that made it. After a crash, `listen` on the same path fails `EADDRINUSE` until the stale file is removed. Removing it is safe here only because `requestSingleInstanceLock` guarantees one app instance; note that where the unlink happens, because it is the assumption that makes it correct.

**Files:**
- Create: `src/main/hooks/server.ts`
- Test: `tests/integration/hook-server.test.ts`

**Interfaces:**
- Consumes: `parseHookLine`, `MAX_LINE_BYTES`, `HookEventMessage` from `src/main/hooks/protocol.ts`
- Produces:
  - `class HookServer` — `constructor(socketPath: string)`, `start(): Promise<void>`, `stop(): Promise<void>`, `onEvent(listener: (message: HookEventMessage) => void): void`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/hook-server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { connect } from 'node:net'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookServer } from '../../src/main/hooks/server'
import type { HookEventMessage } from '../../src/main/hooks/protocol'

const ID = '0123456789abcdef'

let dir: string
let server: HookServer | null = null

async function start(): Promise<{ server: HookServer; socket: string; seen: HookEventMessage[] }> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
  const socket = join(dir, 'hook.sock')
  const seen: HookEventMessage[] = []
  server = new HookServer(socket)
  server.onEvent((message) => seen.push(message))
  await server.start()
  return { server, socket, seen }
}

/** Write raw bytes the way the hook script does and close. */
function send(socket: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.end(payload))
    client.on('close', () => resolve())
    client.on('error', reject)
  })
}

afterEach(async () => {
  await server?.stop()
  server = null
  await rm(dir, { recursive: true, force: true })
})

describe('HookServer', () => {
  it('emits a well-formed event', async () => {
    const { socket, seen } = await start()

    await send(socket, `{"tabId":"${ID}","event":"Notification","at":5}\n`)

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]).toEqual({ tabId: ID, event: 'Notification', at: 5 })
  })

  it('handles several events on one connection', async () => {
    const { socket, seen } = await start()

    await send(
      socket,
      `{"tabId":"${ID}","event":"Stop","at":1}\n{"tabId":"${ID}","event":"Notification","at":2}\n`,
    )

    await expect.poll(() => seen.length).toBe(2)
    expect(seen.map((event) => event.event)).toEqual(['Stop', 'Notification'])
  })

  it('handles a line split across two writes', async () => {
    const { socket, seen } = await start()

    await new Promise<void>((resolve, reject) => {
      const client = connect(socket, () => {
        client.write(`{"tabId":"${ID}","event":"St`)
        setTimeout(() => client.end(`op","at":3}\n`), 20)
      })
      client.on('close', () => resolve())
      client.on('error', reject)
    })

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]?.event).toBe('Stop')
  })

  it('emits a final line that arrived without a newline', async () => {
    const { socket, seen } = await start()

    await send(socket, `{"tabId":"${ID}","event":"Stop","at":4}`)

    await expect.poll(() => seen.length).toBe(1)
  })

  // Reachable by anything on the machine that can open the socket. None of
  // this may throw, and none of it may take the server down.
  it('survives garbage without dying, and keeps serving after it', async () => {
    const { socket, seen } = await start()

    await send(socket, 'not json\n')
    await send(socket, '{"tabId":"zzz","event":"Stop","at":1}\n')
    await send(socket, `{"tabId":"${ID}","event":"Nope","at":1}\n`)
    await send(socket, `${'x'.repeat(50_000)}\n`)
    await send(socket, `{"tabId":"${ID}","event":"Stop","at":9}\n`)

    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]?.at).toBe(9)
  })

  it('drops an over-long line without buffering it without limit', async () => {
    const { socket, seen } = await start()

    // A single line far larger than the cap, with no newline in it at all —
    // the shape that would grow a buffer forever if nothing bounded it.
    await send(socket, 'y'.repeat(200_000))

    await expect.poll(() => seen.length, { timeout: 2_000 }).toBe(0)
  })

  it('replaces a stale socket file left by a crash', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const socket = join(dir, 'hook.sock')
    // Not a real socket, just a file in the way — which is what a crashed
    // process leaves behind and what makes listen() fail EADDRINUSE.
    await writeFile(socket, 'stale', 'utf8')

    server = new HookServer(socket)
    await expect(server.start()).resolves.toBeUndefined()
  })

  it('says plainly when the path is too long for a unix socket', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-srv-'))
    const deep = join(dir, 'a'.repeat(60), 'b'.repeat(60))
    await mkdir(deep, { recursive: true })
    const socket = join(deep, 'hook.sock')

    server = new HookServer(socket)
    // Not a bare EINVAL from bind(2), which says nothing about what to change.
    await expect(server.start()).rejects.toThrow(/too long/i)
    server = null
  })

  it('can be stopped and started again on the same path', async () => {
    const { socket, seen } = await start()
    await server?.stop()
    await server?.start()

    await send(socket, `{"tabId":"${ID}","event":"Stop","at":1}\n`)

    await expect.poll(() => seen.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/hook-server.test.ts`

Expected: FAIL — cannot resolve `../../src/main/hooks/server`.

- [ ] **Step 3: Write the server**

Create `src/main/hooks/server.ts`:

```ts
import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { MAX_LINE_BYTES, parseHookLine, type HookEventMessage } from './protocol'

/**
 * macOS caps a unix socket path (`sun_path`) near 104 bytes. Past it, `bind`
 * fails with a bare `EINVAL` that says nothing about the length — which is
 * exactly the failure a deep `PRCLI_CONFIG_DIR` under a temp directory would
 * produce in CI.
 */
const MAX_SOCKET_PATH_BYTES = 103

/**
 * Enough for a great many well-formed lines, and a hard ceiling on what one
 * connection can make the process hold. A client that sends no newline at all
 * is the shape that would otherwise grow a buffer forever.
 */
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 64

/**
 * Listens for hook events on a unix socket.
 *
 * Holds no state and decides nothing: it parses lines and emits them. What a
 * state means is the machine's job, and which tab it belongs to is the
 * registry's. That is what makes it testable against a raw socket with no app
 * around it.
 *
 * Everything arriving here is untrusted — the socket is reachable by anything
 * on the machine that can open it — so a bad line is dropped and the
 * connection carries on. Nothing a client can send may take the server down.
 */
export class HookServer {
  private server: Server | null = null
  private readonly listeners = new Set<(message: HookEventMessage) => void>()

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    if (this.server) return
    if (Buffer.byteLength(this.socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `HookServer: socket path is too long for macOS (${Buffer.byteLength(this.socketPath, 'utf8')} bytes, ` +
          `limit ${MAX_SOCKET_PATH_BYTES}): ${this.socketPath}. Set PRCLI_CONFIG_DIR to a shorter path.`,
      )
    }

    // A unix socket file outlives the process that created it, so a crash
    // leaves one behind and `listen` fails EADDRINUSE on the next launch.
    // Removing it is safe only because `requestSingleInstanceLock` guarantees
    // there is no second live instance to steal the socket from.
    await rm(this.socketPath, { force: true })

    const server = createServer((connection) => this.accept(connection))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  private accept(connection: Socket): void {
    let buffer = ''
    connection.setEncoding('utf8')
    // A hook writes and hangs up; it never reads. Anything that connects and
    // stays silent should not hold a handle open indefinitely.
    connection.setTimeout(5_000, () => connection.destroy())
    connection.on('error', () => connection.destroy())

    const take = (line: string): void => {
      const message = parseHookLine(line)
      if (!message) return
      for (const listener of this.listeners) listener(message)
    }

    connection.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        take(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      // No newline in sight and already past the ceiling: this is not a line
      // that is going to arrive. Drop what is held rather than keep growing.
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) buffer = ''
    })

    connection.on('end', () => {
      // The hook script writes a trailing newline, but a client that closed
      // without one still meant to send what it sent.
      if (buffer.length > 0) take(buffer)
      buffer = ''
    })
  }

  onEvent(listener: (message: HookEventMessage) => void): void {
    this.listeners.add(listener)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.socketPath, { force: true })
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/hook-server.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the two halves meet**

The script and the server were tested separately against fakes. Check them against each other once — this is the join the whole milestone rests on. Add to `tests/integration/hook-server.test.ts`:

```ts
import { chmod, writeFile as write } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { renderScript } from '../../src/main/hooks/install'

const exec = promisify(execFile)

it('receives what the real hook script sends', async () => {
  const { socket, seen } = await start()
  const script = join(dir, 'prcli-hook')
  await write(script, renderScript({ socket, spool: join(dir, 'hook.spool') }), 'utf8')
  await chmod(script, 0o755)

  await exec(script, ['UserPromptSubmit'], {
    env: { PATH: process.env.PATH ?? '', PRCLI_TAB_ID: ID },
  })

  await expect.poll(() => seen.length, { timeout: 4_000 }).toBe(1)
  expect(seen[0]?.event).toBe('UserPromptSubmit')
  expect(seen[0]?.at).toBeGreaterThan(1_700_000_000_000)
})
```

Run: `npx vitest run tests/integration/hook-server.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 6: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/hooks/server.ts tests/integration/hook-server.test.ts
git commit -m "$(cat <<'EOF'
Listen for hook events on a unix socket

Parses lines and emits them. It holds no state and decides nothing —
what a state means is the machine's job and which tab owns it is the
registry's — which is what makes it testable against a raw socket with
no app around it.

Everything arriving is untrusted, so a bad line is dropped and the
connection carries on. Tested with garbage, a bad tab id, an unknown
event, a 50KB line and a 200KB line with no newline in it at all; after
all of that the server still serves the next valid event. The buffer has
a hard ceiling because a client that never sends a newline is otherwise
an unbounded allocation.

Two macOS specifics, both with tests. sun_path is capped near 104 bytes
and bind() past it fails as a bare EINVAL saying nothing about length —
plausible under a temp PRCLI_CONFIG_DIR in CI — so the length is checked
up front and reported in words. And a socket file outlives its process,
so a crash leaves one behind and listen() fails EADDRINUSE; it is
unlinked first, which is safe only because requestSingleInstanceLock
guarantees no second instance is holding it.

One test runs the real script against the real server. Both halves were
otherwise tested against fakes, and that join is what the milestone
rests on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The spool

A session sitting in `waiting` is, by definition, doing nothing that would fire another hook. Without this, every relaunch renders it hollow — indistinguishable from dead, and exactly the signal the app exists for.

The script already appends to the spool when the socket write fails (Task 7). This is the reading half.

The one subtlety worth getting right: **rotate, do not truncate.** A backgrounded hook can append between the read and the truncate, and truncation would swallow it silently. Renaming the file aside is atomic; a hook that appends to the old inode afterwards loses one event it was already going to lose.

**Files:**
- Create: `src/main/hooks/spool.ts`
- Test: `tests/integration/spool.test.ts`

**Interfaces:**
- Consumes: `parseHookLine`, `HookEventMessage` from `src/main/hooks/protocol.ts`
- Produces:
  - `drainSpool(spoolPath: string, nowMs: number): Promise<HookEventMessage[]>`
  - `MAX_SPOOL_LINES = 4096`, `MAX_SPOOL_AGE_MS = 86_400_000`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/spool.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainSpool, MAX_SPOOL_LINES } from '../../src/main/hooks/spool'
import { formatHookLine } from '../../src/main/hooks/protocol'
import type { HookEvent } from '../../src/main/status/machine'

const ID = '0123456789abcdef'
const NOW = 1_800_000_000_000

let dir: string

async function spoolWith(lines: string[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-spool-'))
  const path = join(dir, 'hook.spool')
  await writeFile(path, lines.join(''), 'utf8')
  return path
}

function line(event: HookEvent, at: number): string {
  return formatHookLine({ tabId: ID, event, at })
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('drainSpool', () => {
  it('returns nothing when there is no spool', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-spool-'))
    expect(await drainSpool(join(dir, 'hook.spool'), NOW)).toEqual([])
  })

  it('returns events in the order they were appended', async () => {
    const path = await spoolWith([line('UserPromptSubmit', NOW - 3), line('Notification', NOW - 2)])

    const events = await drainSpool(path, NOW)

    // Append order is chronological, and replaying out of order would land a
    // tab in the state before the one it actually reached.
    expect(events.map((event) => event.event)).toEqual(['UserPromptSubmit', 'Notification'])
  })

  it('removes the spool once drained', async () => {
    const path = await spoolWith([line('Stop', NOW)])

    await drainSpool(path, NOW)

    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('leaves no rotation file behind', async () => {
    const path = await spoolWith([line('Stop', NOW)])

    await drainSpool(path, NOW)

    expect(await readdir(dir)).toEqual([])
  })

  it('drains a second time to nothing', async () => {
    const path = await spoolWith([line('Stop', NOW)])

    expect(await drainSpool(path, NOW)).toHaveLength(1)
    expect(await drainSpool(path, NOW)).toEqual([])
  })

  it('skips lines it cannot parse and keeps the rest', async () => {
    const path = await spoolWith(['garbage\n', line('Stop', NOW), '\n', '{"partial":\n'])

    const events = await drainSpool(path, NOW)

    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('Stop')
  })

  it('discards events older than a day', async () => {
    const path = await spoolWith([
      line('Notification', NOW - 25 * 60 * 60 * 1000),
      line('Stop', NOW - 60 * 1000),
    ])

    const events = await drainSpool(path, NOW)

    // A day-old "waiting" describes a session that has since been answered,
    // restarted or killed. Replaying it would light a dot for a past.
    expect(events.map((event) => event.event)).toEqual(['Stop'])
  })

  it('keeps the newest lines when the file is over the cap', async () => {
    const many: string[] = []
    for (let index = 0; index < MAX_SPOOL_LINES + 500; index += 1) {
      many.push(line('PostToolUse', NOW - (MAX_SPOOL_LINES + 500 - index)))
    }
    many.push(line('Notification', NOW))
    const path = await spoolWith(many)

    const events = await drainSpool(path, NOW)

    expect(events).toHaveLength(MAX_SPOOL_LINES)
    // The newest describe the present; the oldest are what to drop.
    expect(events[events.length - 1]?.event).toBe('Notification')
  })

  // Rotate-not-truncate, from the reader's side: a rotation file left behind
  // by a drain that crashed halfway must not silently lose its events.
  it('picks up a rotation file left by an interrupted drain', async () => {
    const path = await spoolWith([line('Stop', NOW)])
    await writeFile(`${path}.draining`, line('Notification', NOW), 'utf8')

    const events = await drainSpool(path, NOW)

    expect(events.map((event) => event.event).sort()).toEqual(['Notification', 'Stop'])
    expect(await readdir(dir)).toEqual([])
  })

  it('survives an unreadable spool rather than failing the launch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-spool-'))
    const path = join(dir, 'hook.spool')
    // A directory where a file should be: unreadable in a way no amount of
    // retrying fixes. Restore must still finish.
    await rm(path, { force: true })
    await (await import('node:fs/promises')).mkdir(path)

    await expect(drainSpool(path, NOW)).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/spool.test.ts`

Expected: FAIL — cannot resolve `../../src/main/hooks/spool`.

- [ ] **Step 3: Write the spool reader**

Create `src/main/hooks/spool.ts`:

```ts
import { readFile, rename, rm } from 'node:fs/promises'
import { parseHookLine, type HookEventMessage } from './protocol'

/**
 * Roughly a day of seven events across twelve sessions, at a few hundred
 * kilobytes of this record size. Past it the oldest go, because the newest are
 * the ones that describe the present.
 */
export const MAX_SPOOL_LINES = 4096

/**
 * A day-old `waiting` describes a session that has since been answered,
 * restarted or killed. Replaying it would light a dot for a past.
 */
export const MAX_SPOOL_AGE_MS = 24 * 60 * 60 * 1000

async function readAndRemove(path: string): Promise<string> {
  try {
    const contents = await readFile(path, 'utf8')
    await rm(path, { force: true })
    return contents
  } catch {
    // Missing is the normal case — no events were spooled. Unreadable for any
    // other reason must not fail the launch either: the worst case is losing
    // states the user can rebuild by pressing a key in each session.
    return ''
  }
}

/**
 * Take everything the hook script spooled while the app was down.
 *
 * **Rotate, do not truncate.** A backgrounded hook can append between a read
 * and a truncate, and truncation would swallow it silently. The rename is
 * atomic, and a hook that appends to the old inode afterwards loses one event
 * it was already going to lose.
 *
 * A `.draining` file left by a drain that crashed halfway is picked up first,
 * so an interrupted launch costs nothing.
 *
 * Callers must run this *after* reconciling against live tmux, so events for
 * tabs tmux no longer has are discarded rather than resurrecting dots for dead
 * sessions.
 */
export async function drainSpool(
  spoolPath: string,
  nowMs: number,
): Promise<HookEventMessage[]> {
  const rotated = `${spoolPath}.draining`

  // Whatever a previous interrupted drain left behind, before this one adds to it.
  const leftover = await readAndRemove(rotated)

  let current = ''
  try {
    await rename(spoolPath, rotated)
    current = await readAndRemove(rotated)
  } catch {
    // Nothing to rotate, or a spool that cannot be renamed. Either way there
    // is nothing more to take, and a launch must not fail over it.
  }

  const events: HookEventMessage[] = []
  for (const line of `${leftover}${current}`.split('\n')) {
    const message = parseHookLine(line)
    if (!message) continue
    if (nowMs - message.at > MAX_SPOOL_AGE_MS) continue
    events.push(message)
  }

  return events.length > MAX_SPOOL_LINES ? events.slice(-MAX_SPOOL_LINES) : events
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/spool.test.ts`

Expected: PASS, 11 tests.

- [ ] **Step 5: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/hooks/spool.ts tests/integration/spool.test.ts
git commit -m "$(cat <<'EOF'
Replay the events that arrived while the app was down

A session sitting in `waiting` does nothing that would fire another
hook, so without this every relaunch renders it hollow — indistinguishable
from dead, and exactly the signal the app exists for.

Rotate, do not truncate. A backgrounded hook can append between a read
and a truncate, and truncation would swallow it silently. The rename is
atomic; a hook appending to the old inode afterwards loses one event it
was already going to lose. A `.draining` file left by a drain that
crashed halfway is picked up first, so an interrupted launch costs nothing.

Events older than 24 hours are dropped: a day-old `waiting` describes a
session since answered, restarted or killed, and replaying it lights a
dot for a past. Past 4096 lines the oldest go, because the newest
describe the present.

An unreadable spool resolves to no events rather than failing the
launch. The worst case is losing states the user rebuilds by pressing a
key in each session.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `PRCLI_TAB_ID` in the session environment

`PtySessionOptions` has declared `env?: NodeJS.ProcessEnv` since M1 and nothing has ever passed it. This task passes it.

The semantics matter. tmux gives a session the client environment it was **created** with; a reattach does not update it. That is correct here rather than a limitation: the shell inside already holds the value, and the value is the same one, because the tab id is the second half of the tmux session name and does not change across a relaunch.

A pane created inside the session later from a plain terminal may not inherit it. That session resolves to `unknown`, which is the honest answer.

**Files:**
- Modify: `src/main/sessions/manager.ts`
- Test: `tests/integration/manager.test.ts` (modify)

**Interfaces:**
- Consumes: `TabType` from `src/shared/ipc.ts`
- Produces: every session created by `SessionManager.open` carries `PRCLI_TAB_ID=<tab id>` in its environment

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/manager.test.ts`. Match the file's existing helpers for creating a manager against `-L prcli-test` and cleaning up — read it first and reuse what is there rather than adding a second way to do the same thing.

```ts
  it('puts the tab id in the session environment, where a hook can read it', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), type: 'shell' })

    // Ask tmux what the session's environment holds, rather than asking the
    // shell — the shell may not have finished starting, and the session
    // environment is the thing that outlives this client anyway.
    await expect
      .poll(
        async () => {
          try {
            const { stdout } = await run('tmux', [
              '-L',
              SOCKET,
              'show-environment',
              '-t',
              `=${record.tmuxSession}`,
              'PRCLI_TAB_ID',
            ])
            return stdout.trim()
          } catch {
            return ''
          }
        },
        { timeout: 10_000 },
      )
      .toBe(`PRCLI_TAB_ID=${record.id}`)

    manager.detach(record.id)
  })

  it('keeps the same tab id in the environment across a detach and reattach', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), type: 'shell' })
    await expect.poll(async () => sessionExists(record.tmuxSession), { timeout: 10_000 }).toBe(true)

    manager.detach(record.id)
    const again = manager.open({
      id: record.id,
      projectSlug: 'lumio',
      cwd: tmpdir(),
      tmuxSession: record.tmuxSession,
      type: 'shell',
    })

    // The id is the second half of the session name and does not change, so a
    // reattached session's environment is already correct — which is why tmux
    // not updating it on reattach is right rather than a limitation.
    expect(again.id).toBe(record.id)
    const { stdout } = await run('tmux', [
      '-L',
      SOCKET,
      'show-environment',
      '-t',
      `=${record.tmuxSession}`,
      'PRCLI_TAB_ID',
    ])
    expect(stdout.trim()).toBe(`PRCLI_TAB_ID=${record.id}`)

    manager.detach(record.id)
  })

  it('carries the tab type on the record and through a move', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({
      projectSlug: 'lumio',
      cwd: tmpdir(),
      command: 'sleep 600',
      type: 'preset',
    })
    await expect.poll(async () => sessionExists(record.tmuxSession), { timeout: 10_000 }).toBe(true)

    const moved = await manager.moveToProject(record.id, 'gco')

    // A tab that was a preset before the move is still a preset after it.
    expect(moved.type).toBe('preset')
    manager.detach(moved.id)
  })

  it('defaults an unspecified type to shell', () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    expect(record.type).toBe('shell')
    manager.detach(record.id)
  })
```

If the file has no `sessionExists` helper, add one that shells out to `tmux -L prcli-test has-session -t '=<name>'` and returns a boolean, or reuse whatever equivalent the file already has.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/manager.test.ts`

Expected: the environment tests FAIL — `show-environment` reports `-PRCLI_TAB_ID` (tmux's notation for unset).

**Before running anything that touches tmux, confirm you are on the test socket.** Every command in this task passes `-L prcli-test`. The developer's own tmux server holds live, irreplaceable sessions; a bare `tmux` command here would find them.

- [ ] **Step 3: Pass the environment**

In `src/main/sessions/manager.ts`, add `type` to `OpenInput`:

```ts
export interface OpenInput {
  projectSlug: string
  cwd: string
  command?: string
  /** Supply to reattach an existing tab; omit to create a new one. */
  id?: string
  /** Saved tmux name, checked against the one this input encodes to. */
  tmuxSession?: string
  cols?: number
  rows?: number
  /** Declares intent only — it does not gate status. Defaults to 'shell'. */
  type?: TabType
}
```

and in `open`, after the record is built, pass the environment into `PtySession`:

```ts
    const session = new PtySession(this.adapter, {
      tmuxSession: record.tmuxSession,
      cwd: record.cwd,
      cols,
      rows,
      command: record.command,
      // What the hook script reads to say which tab an event came from.
      //
      // tmux gives a session the client environment it was *created* with, and
      // a reattach does not update it. That is right rather than a limitation:
      // the id is the second half of the session name and never changes, so a
      // session created by a previous run already holds the correct value.
      //
      // Every tab gets this, not only `claude` tabs. The way this app is used
      // is to open a tab and type `claude` into it, and a type field that
      // decided who got an id would leave exactly those sessions dark.
      env: { PRCLI_TAB_ID: id },
    })
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/manager.test.ts`

Expected: PASS.

- [ ] **Step 5: Confirm the developer's own tmux server is untouched**

Run: `tmux ls`

Compare against the session list captured before this task started. It must be identical, and any attached session must still be attached. If it differs in any way, **stop and report immediately** — that server holds irreplaceable work.

- [ ] **Step 6: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/sessions/manager.ts tests/integration/manager.test.ts
git commit -m "$(cat <<'EOF'
Put the tab id in every session's environment

PtySessionOptions has declared `env` since M1 and nothing ever passed
it. This passes it, and the hook script reads PRCLI_TAB_ID from it to
say which tab an event came from.

Every tab gets one, not only `claude` tabs. The way this app is used is
to open a tab and type `claude` into it, so a type field deciding who
got an id would leave exactly those sessions dark.

tmux gives a session the client environment it was created with and does
not update it on reattach. That is right rather than a limitation: the
id is the second half of the session name and never changes, so a
session created by a previous run already holds the correct value —
asserted by a test that detaches and reattaches and reads it back.

The type now travels on the record and survives a move, so a preset tab
filed into another project is still a preset.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The registry, and the channels that carry it

Where the state per tab actually lives, and how it reaches the renderer. Main owns it because notifications, sounds and the dock badge all need it and all live here — and because ⌘R must not blank the board.

This task also changes shipped behaviour: **a tab whose tmux session dies stops being removed.** Today `App.tsx` drops it on any exit with `sessionAlive: false`, which makes `crashed` a state that can never be rendered. Main keeps reporting the exit exactly as it does; what changes is what the renderer does with it (Task 15) and that main now records a state instead of only forgetting a row.

**Restart is a new attach path.** The global constraint applies in full: it must carry geometry, or tmux resizes the recreated session to 80×24. Geometry is remembered in `register.ts` on every resize, because the manager's `Entry` — where geometry lives — is deleted when the session dies, which is exactly when Restart needs it.

**Files:**
- Create: `src/main/status/registry.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/register.ts`, `src/preload/index.ts`
- Test: `tests/unit/registry.test.ts`

**Interfaces:**
- Consumes: `stateForHook`, `stateForExit`, `stateForOpen` (Task 4); `HookEventMessage` (Task 5); `worst` (Task 2)
- Produces:
  - `class StatusRegistry` — `applyOpen(id, type)`, `applyHook(message)`, `applyExit(id, code)`, `forget(id)`, `get(id)`, `snapshot()`, `waitingCount()`, `onTransition(listener)`
  - `interface StatusTransition { tabId: string; from: TabState | null; to: TabState }`
  - Channels `status`, `statusChanged`, `restartTab`, `dismissTab`, `focusTab`
  - `PrcliApi.status()`, `.onStatus()`, `.restartTab(tab)`, `.dismissTab(id)`, `.onFocusTab()`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { StatusRegistry, type StatusTransition } from '../../src/main/status/registry'

const ID = '0123456789abcdef'
const OTHER = 'fedcba9876543210'

function hook(tabId: string, event: 'Stop' | 'Notification' | 'UserPromptSubmit' | 'SessionEnd') {
  return { tabId, event, at: 1 } as const
}

describe('StatusRegistry', () => {
  it('has nothing to say about a tab it has not seen', () => {
    const registry = new StatusRegistry()
    expect(registry.get(ID)).toBeNull()
    expect(registry.snapshot()).toEqual({})
  })

  it('records the state a tab opens in', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'claude')
    expect(registry.get(ID)).toBe('unknown')
  })

  it('keeps a shell tab out of the map entirely until it says something', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'shell')

    expect(registry.snapshot()).toEqual({})

    // Typing `claude` into a shell tab is the common case, and the first hook
    // is what makes it a Claude tab. Nothing about its declared type may stop
    // that.
    registry.applyHook(hook(ID, 'Notification'))
    expect(registry.get(ID)).toBe('waiting')
  })

  it('moves through the states its events imply', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'claude')

    registry.applyHook(hook(ID, 'UserPromptSubmit'))
    expect(registry.get(ID)).toBe('thinking')
    registry.applyHook(hook(ID, 'Notification'))
    expect(registry.get(ID)).toBe('waiting')
    registry.applyHook(hook(ID, 'Stop'))
    expect(registry.get(ID)).toBe('idle')
  })

  it('emits a transition with what it came from', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.applyOpen(ID, 'claude')
    registry.applyHook(hook(ID, 'Notification'))

    expect(seen).toEqual([
      { tabId: ID, from: null, to: 'unknown' },
      { tabId: ID, from: 'unknown', to: 'waiting' },
    ])
  })

  it('emits nothing when the state does not change', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.applyHook(hook(ID, 'Notification'))

    // Claude re-fires Notification while a prompt sits unanswered. A toast per
    // repeat is a toast every sixty seconds for a session you already know about.
    expect(seen).toEqual([])
    expect(registry.get(ID)).toBe('waiting')
  })

  it('records a death by its exit code', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    expect(registry.get(ID)).toBe('running')

    registry.applyExit(ID, 1)
    expect(registry.get(ID)).toBe('crashed')
  })

  it('records a clean exit as ended', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 0)
    expect(registry.get(ID)).toBe('ended')
  })

  it('forgets a tab entirely on dismiss', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 1)

    registry.forget(ID)

    expect(registry.get(ID)).toBeNull()
    // Or the dock badge would keep counting a tab that is no longer on screen.
    expect(registry.snapshot()).toEqual({})
  })

  it('counts only the tabs that are blocking a human', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.applyHook(hook(OTHER, 'UserPromptSubmit'))

    expect(registry.waitingCount()).toBe(1)

    registry.applyHook(hook(OTHER, 'Notification'))
    expect(registry.waitingCount()).toBe(2)

    registry.applyHook(hook(ID, 'Stop'))
    expect(registry.waitingCount()).toBe(1)
  })

  it('takes a dead tab out of the waiting count', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.applyExit(ID, 1)
    expect(registry.waitingCount()).toBe(0)
  })

  it('returns a snapshot that cannot be mutated from outside', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Stop'))

    const snapshot = registry.snapshot()
    snapshot[ID] = 'crashed'

    expect(registry.get(ID)).toBe('idle')
  })

  it('reopening a tab replaces whatever it died as', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 1)

    registry.applyOpen(ID, 'preset')

    // Restart recreates the session under the same id; a stale `crashed` on it
    // would show a red dot over a session that is running fine.
    expect(registry.get(ID)).toBe('running')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/registry.test.ts`

Expected: FAIL — cannot resolve `../../src/main/status/registry`.

- [ ] **Step 3: Write the registry**

Create `src/main/status/registry.ts`:

```ts
import type { TabType } from '../../shared/ipc'
import type { TabState } from '../../shared/status'
import type { HookEventMessage } from '../hooks/protocol'
import { stateForExit, stateForHook, stateForOpen } from './machine'

export interface StatusTransition {
  tabId: string
  /** Null when the tab had no state at all — a shell nothing had run in. */
  from: TabState | null
  to: TabState
}

/**
 * What every tab is doing, in the main process.
 *
 * Main owns this rather than the renderer for two reasons: notifications,
 * sounds and the dock badge all live here and all need it, and a ⌘R must not
 * blank the board.
 *
 * A tab absent from the map has no state, which is not the same as `unknown`.
 * Absent means "draw no dot" — a shell nobody has run anything in. `unknown`
 * means "this should have a state and does not", which is what a `claude` tab
 * with a broken hook install looks like.
 */
export class StatusRegistry {
  private readonly states = new Map<string, TabState>()
  private readonly listeners = new Set<(transition: StatusTransition) => void>()

  private set(tabId: string, to: TabState): void {
    const from = this.states.get(tabId) ?? null
    // Claude re-fires Notification while a prompt sits unanswered. Emitting on
    // every repeat would be a toast a minute for a session you already know
    // about, so only changes are transitions.
    if (from === to) return
    this.states.set(tabId, to)
    for (const listener of this.listeners) listener({ tabId, from, to })
  }

  /** A tab has been opened, or restarted under the same id. */
  applyOpen(tabId: string, type: TabType): void {
    const initial = stateForOpen(type)
    if (initial === null) {
      // A shell gets no dot until something in it speaks. Delete rather than
      // leave whatever it died as: restart reuses the id, and a stale
      // `crashed` would show red over a session running fine.
      this.forget(tabId)
      return
    }
    this.set(tabId, initial)
  }

  applyHook(message: HookEventMessage): void {
    this.set(message.tabId, stateForHook(message.event))
  }

  applyExit(tabId: string, code: number): void {
    this.set(tabId, stateForExit(code))
  }

  /** Drop the tab entirely — dismissed, or killed on purpose. */
  forget(tabId: string): void {
    this.states.delete(tabId)
  }

  get(tabId: string): TabState | null {
    return this.states.get(tabId) ?? null
  }

  /** A copy: a caller that mutated this would silently rewrite the truth. */
  snapshot(): Record<string, TabState> {
    return Object.fromEntries(this.states)
  }

  /** What the dock badge shows: the tabs that are blocking a human. */
  waitingCount(): number {
    let count = 0
    for (const state of this.states.values()) if (state === 'waiting') count += 1
    return count
  }

  onTransition(listener: (transition: StatusTransition) => void): void {
    this.listeners.add(listener)
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/registry.test.ts`

Expected: PASS, 13 tests.

- [ ] **Step 5: Add the wire types and channels**

In `src/shared/ipc.ts`, add to `CHANNELS`:

```ts
  status: 'prcli:status',
  statusChanged: 'prcli:statusChanged',
  restartTab: 'prcli:restartTab',
  dismissTab: 'prcli:dismissTab',
  focusTab: 'prcli:focusTab',
```

and the payload types:

```ts
export interface StatusEvent {
  tabId: string
  state: TabState
}

/** What Restart needs: the dead tab's record, plus the size to attach at. */
export interface RestartRequest {
  tab: TabDescriptor
  cols?: number
  rows?: number
}
```

and to `PrcliApi`:

```ts
  /** Every tab's state, for a renderer that has just mounted or reloaded. */
  status(): Promise<Record<string, TabState>>
  onStatus(listener: (event: StatusEvent) => void): () => void
  /** Recreate a dead tab's session under the same id, cwd, command and type. */
  restartTab(request: RestartRequest): Promise<TabDescriptor>
  /** Stop tracking a dead tab: the renderer has dropped its tombstone. */
  dismissTab(id: string): void
  /** A clicked toast asking the renderer to select a particular tab. */
  onFocusTab(listener: (tabId: string) => void): () => void
```

In `src/preload/index.ts`, expose them alongside the existing entries:

```ts
  status: () => ipcRenderer.invoke(CHANNELS.status),
  onStatus: (listener: (event: StatusEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: StatusEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.statusChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.statusChanged, handler)
  },
  restartTab: (request) => ipcRenderer.invoke(CHANNELS.restartTab, request),
  dismissTab: (id) => ipcRenderer.send(CHANNELS.dismissTab, id),
  onFocusTab: (listener: (tabId: string) => void) => {
    const handler = (_event: IpcRendererEvent, tabId: string): void => listener(tabId)
    ipcRenderer.on(CHANNELS.focusTab, handler)
    return () => ipcRenderer.removeListener(CHANNELS.focusTab, handler)
  },
```

with `StatusEvent` added to the type import at the top.

- [ ] **Step 6: Wire the registry into `registerIpc`**

`registerIpc` gains a registry parameter. Change its signature in `src/main/ipc/register.ts`:

```ts
export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  registry: StatusRegistry,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
): void {
```

with `import { StatusRegistry } from '../status/registry'` and `import type { RestartRequest, StatusEvent } from '../../shared/ipc'`.

Add the geometry memory near `pendingKills`:

```ts
  // The size each tab's client last reported.
  //
  // Restart is a new attach path, and every new attach path in this codebase
  // has shipped with the same defect: attach at the 80×24 default and tmux,
  // seeing its only client, resizes the window down and SIGWINCHes whatever is
  // inside — permanently reflowing the user's scrollback. The manager keeps
  // geometry on its `Entry`, but the entry is deleted when the session dies,
  // which is precisely when Restart needs it. So it is remembered here too.
  const lastGeometry = new Map<string, { cols: number; rows: number }>()
```

Record it in the existing resize handler:

```ts
  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) => {
    // Same guard the manager applies, so a rejected size is never remembered
    // as the one a restart should attach at.
    if (cols >= 1 && rows >= 1) lastGeometry.set(id, { cols, rows })
    manager.resize(id, cols, rows)
  })
```

Publish transitions to the renderer, next to the existing `manager.onData` wiring:

```ts
  registry.onTransition(({ tabId, to }) => {
    const payload: StatusEvent = { tabId, state: to }
    send(CHANNELS.statusChanged, payload)
  })

  ipcMain.handle(CHANNELS.status, () => registry.snapshot())
```

Record the initial state on every open. In the `CHANNELS.open` handler, after `rememberTab(record)`:

```ts
    registry.applyOpen(record.id, record.type)
```

Record a death in the existing `manager.onExit` block, inside the async body, after `sessionAlive` is resolved:

```ts
      if (!sessionAlive) registry.applyExit(record.id, code)
```

This sits alongside the existing `forgetTab` call and does not replace it: config still drops the row, and the state is what keeps a red dot on screen until the user dismisses it. A dead tab therefore never reaches disk, and a relaunch prunes it exactly as it does today — which is why tombstones need no migration.

Forget the state when a kill succeeds, in the `CHANNELS.kill` handler after `forgetTab(id)`:

```ts
      registry.forget(id)
      lastGeometry.delete(id)
```

Add the two new handlers at the end of the function:

```ts
  ipcMain.handle(
    CHANNELS.restartTab,
    async (_event, request: RestartRequest): Promise<TabDescriptor> => {
      const { tab } = request
      // Same guard `open` applies: node-pty does not throw on a missing cwd,
      // it yields a live process that produces nothing, so the tab comes back
      // permanently blank while looking fine.
      if (!(await isDirectory(tab.cwd))) {
        throw new Error(`Cannot restart: ${tab.cwd} is not a directory`)
      }
      const remembered = lastGeometry.get(tab.id)
      const record = manager.open({
        id: tab.id,
        projectSlug: tab.projectSlug,
        cwd: tab.cwd,
        command: tab.command,
        type: tab.type,
        // The renderer's live measurement first, the last one main saw
        // second. Attaching at neither would let tmux shrink the recreated
        // session to 80×24 — the defect this codebase has now shipped twice.
        cols: request.cols ?? remembered?.cols,
        rows: request.rows ?? remembered?.rows,
      })
      await rememberTab(record)
      registry.applyOpen(record.id, record.type)
      return record
    },
  )

  ipcMain.on(CHANNELS.dismissTab, (_event, id: string) => {
    // The row is already gone from config — the exit handler forgot it. This
    // drops the state, so the dock badge stops counting a tab nobody can see.
    registry.forget(id)
    lastGeometry.delete(id)
  })
```

Finally, in `src/main/index.ts`, construct the registry and pass it:

```ts
const registry = new StatusRegistry()
```

near the manager, and `registerIpc(manager, () => mainWindow, registry)` at the call site.

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test && npm run lint`

Expected: clean. The existing E2E suites still pass unchanged — nothing in the renderer has moved yet.

Run: `npm run e2e`

Expected: 22 passing.

- [ ] **Step 8: Confirm the developer's tmux server is untouched, then commit**

Run: `tmux ls` and compare against the list captured before the task.

```bash
git add -A
git commit -m "$(cat <<'EOF'
Keep every tab's state in the main process

Main owns the registry because notifications, sounds and the dock badge
all live here and all need it — and because a ⌘R must not blank the
board.

A tab absent from the map has no state, which is not the same as
`unknown`. Absent is "draw no dot", the shell nobody has run anything
in. `unknown` is "this should have a state and does not", which is what
a claude tab with a broken hook install looks like.

Only changes are transitions. Claude re-fires Notification while a
prompt sits unanswered, and emitting on every repeat would be a toast a
minute for a session you already know about.

Restart carries geometry. It is a new attach path, and every new attach
path in this codebase has shipped with the same defect: attach at 80×24
and tmux, seeing its only client, resizes the window down and SIGWINCHes
what is inside, reflowing scrollback permanently. The manager keeps
geometry on its Entry, but the entry is deleted when the session dies —
precisely when restart needs it — so register.ts remembers it on every
resize instead.

Recording a death does not replace forgetting the row: config still
drops it, and the state is what keeps a red dot on screen until the user
dismisses it. So a dead tab never reaches disk and a relaunch prunes it
as it always has, which is why the tombstones in the renderer need no
migration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The notification rules engine

Pure resolution: given the stored rules and a transition, decide whether to toast, what to play, and how urgent it is. No Electron, no audio, no clock of its own — the time is passed in, so quiet hours are testable without waiting for 10pm.

Two orderings interact and the spec gives both: *later rules override earlier*, and *project-scoped beats global*. Resolved by applying every matching rule in array order, global ones first and project-scoped second. Written down because a reader will otherwise assume one of the two orderings was forgotten.

**Files:**
- Create: `src/main/notify/rules.ts`
- Test: `tests/unit/rules.test.ts`

**Interfaces:**
- Consumes: `NotificationConfig`, `Rule` from `src/shared/ipc.ts`; `TabState` from `src/shared/status.ts`
- Produces:
  - `interface NotificationOutcome { toast: boolean; sound: string | null; urgency: 'low' | 'high' }`
  - `resolve(config: NotificationConfig, input: ResolveInput): NotificationOutcome`
  - `interface ResolveInput { state: TabState; projectId: string | null; attended: boolean; now: Date }`
  - `inQuietHours(quietHours, now): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inQuietHours, resolve } from '../../src/main/notify/rules'
import { DEFAULT_NOTIFICATIONS } from '../../src/main/state/store'
import type { NotificationConfig } from '../../src/shared/ipc'

const AFTERNOON = new Date('2026-07-30T14:00:00')

function config(partial: Partial<NotificationConfig> = {}): NotificationConfig {
  return { rules: [], muteWhenFocused: true, quietHours: null, ...partial }
}

describe('resolve', () => {
  it('says nothing when no rule matches', () => {
    expect(
      resolve(config(), { state: 'thinking', projectId: 'p1', attended: false, now: AFTERNOON }),
    ).toEqual({ toast: false, sound: null, urgency: 'low' })
  })

  it('applies a rule matching the state', () => {
    const rules = config({ rules: [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }] })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'p1', attended: false, now: AFTERNOON }),
    ).toEqual({ toast: true, sound: 'Funk', urgency: 'high' })
  })

  it('ignores a rule for a different state', () => {
    const rules = config({ rules: [{ on: 'idle', toast: true }] })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'p1', attended: false, now: AFTERNOON }).toast,
    ).toBe(false)
  })

  it('treats a rule with no `on` as matching every state', () => {
    const rules = config({ rules: [{ toast: true, urgency: 'high' }] })

    expect(
      resolve(rules, { state: 'ended', projectId: 'p1', attended: false, now: AFTERNOON }).toast,
    ).toBe(true)
  })

  it('lets a later rule override an earlier one', () => {
    const rules = config({
      rules: [
        { on: 'idle', toast: true, sound: 'Glass' },
        { on: 'idle', toast: false },
      ],
    })

    const outcome = resolve(rules, {
      state: 'idle',
      projectId: 'p1',
      attended: false,
      now: AFTERNOON,
    })

    // Only what the later rule states is overridden — it says nothing about
    // sound, so the earlier rule's sound stands.
    expect(outcome.toast).toBe(false)
    expect(outcome.sound).toBe('Glass')
  })

  it('lets a project rule beat a global one declared after it', () => {
    const rules = config({
      rules: [
        { on: 'idle', project: 'lumio', toast: false },
        { on: 'idle', toast: true },
      ],
    })

    // Both orderings from the spec are in play here. Project-scoped wins
    // regardless of position, which is why globals are applied first.
    expect(
      resolve(rules, { state: 'idle', projectId: 'lumio', attended: false, now: AFTERNOON }).toast,
    ).toBe(false)
    expect(
      resolve(rules, { state: 'idle', projectId: 'gco', attended: false, now: AFTERNOON }).toast,
    ).toBe(true)
  })

  it('lets a later project rule override an earlier project rule', () => {
    const rules = config({
      rules: [
        { on: 'waiting', project: 'lumio', toast: true },
        { on: 'waiting', project: 'lumio', toast: false },
      ],
    })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'lumio', attended: false, now: AFTERNOON })
        .toast,
    ).toBe(false)
  })

  it('never applies a project rule to a tab with no project', () => {
    const rules = config({ rules: [{ on: 'waiting', project: 'lumio', toast: true }] })

    // An Unsorted tab has no project row to be scoped by.
    expect(
      resolve(rules, { state: 'waiting', projectId: null, attended: false, now: AFTERNOON }).toast,
    ).toBe(false)
  })

  it('mutes the toast for the tab you are already looking at', () => {
    const rules = config({ rules: [{ on: 'waiting', toast: true, sound: 'Funk' }] })

    const outcome = resolve(rules, {
      state: 'waiting',
      projectId: 'p1',
      attended: true,
      now: AFTERNOON,
    })

    expect(outcome.toast).toBe(false)
    // The sound still plays: a chime for the pane in front of you is the
    // cheapest possible signal, and it is the popup that is redundant.
    expect(outcome.sound).toBe('Funk')
  })

  it('does not mute when muteWhenFocused is off', () => {
    const rules = config({
      rules: [{ on: 'waiting', toast: true }],
      muteWhenFocused: false,
    })

    expect(
      resolve(rules, { state: 'waiting', projectId: 'p1', attended: true, now: AFTERNOON }).toast,
    ).toBe(true)
  })

  it('silences everything during quiet hours', () => {
    const rules = config({
      rules: [{ on: 'waiting', toast: true, sound: 'Funk', urgency: 'high' }],
      quietHours: { from: '22:00', to: '07:00' },
    })

    const outcome = resolve(rules, {
      state: 'waiting',
      projectId: 'p1',
      attended: false,
      now: new Date('2026-07-30T23:30:00'),
    })

    expect(outcome).toEqual({ toast: false, sound: null, urgency: 'low' })
  })

  it('leaves the shipped defaults silent', () => {
    const outcome = resolve(DEFAULT_NOTIFICATIONS, {
      state: 'waiting',
      projectId: 'p1',
      attended: false,
      now: AFTERNOON,
    })

    expect(outcome.toast).toBe(true)
    // Sound is off out of the box because this machine's settings.json
    // already plays Funk on Notification and Glass on Stop.
    expect(outcome.sound).toBeNull()
    expect(outcome.urgency).toBe('high')
  })

  it('does not mutate the config it was given', () => {
    const rules = config({ rules: [{ on: 'waiting', toast: true }] })
    const snapshot = JSON.parse(JSON.stringify(rules))

    resolve(rules, { state: 'waiting', projectId: 'p1', attended: false, now: AFTERNOON })

    expect(rules).toEqual(snapshot)
  })
})

describe('inQuietHours', () => {
  it('is false when none are set', () => {
    expect(inQuietHours(null, AFTERNOON)).toBe(false)
  })

  it('handles a window inside one day', () => {
    const window = { from: '09:00', to: '17:00' }
    expect(inQuietHours(window, new Date('2026-07-30T12:00:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T08:59:00'))).toBe(false)
    expect(inQuietHours(window, new Date('2026-07-30T17:30:00'))).toBe(false)
  })

  it('handles a window that wraps past midnight', () => {
    const window = { from: '22:00', to: '07:00' }
    expect(inQuietHours(window, new Date('2026-07-30T23:30:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T02:00:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T12:00:00'))).toBe(false)
  })

  it('is inclusive of the start and exclusive of the end', () => {
    const window = { from: '22:00', to: '07:00' }
    expect(inQuietHours(window, new Date('2026-07-30T22:00:00'))).toBe(true)
    expect(inQuietHours(window, new Date('2026-07-30T07:00:00'))).toBe(false)
  })

  it('ignores a window it cannot parse rather than silencing everything', () => {
    // A hand-edited config must not be able to mute the app permanently in a
    // way nothing explains.
    expect(inQuietHours({ from: 'evening', to: 'morning' }, AFTERNOON)).toBe(false)
    expect(inQuietHours({ from: '25:00', to: '07:00' }, AFTERNOON)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/rules.test.ts`

Expected: FAIL — cannot resolve `../../src/main/notify/rules`.

- [ ] **Step 3: Write the engine**

Create `src/main/notify/rules.ts`:

```ts
import type { NotificationConfig, Rule } from '../../shared/ipc'
import type { TabState } from '../../shared/status'

export interface NotificationOutcome {
  toast: boolean
  /** A macOS system sound name, or null for silence. */
  sound: string | null
  urgency: 'low' | 'high'
}

export interface ResolveInput {
  state: TabState
  /** Null for a tab under Unsorted, which has no project row to be scoped by. */
  projectId: string | null
  /** Window focused *and* this is the tab being looked at. */
  attended: boolean
  /** Passed in rather than read, so quiet hours are testable at any hour. */
  now: Date
}

const SILENT: NotificationOutcome = { toast: false, sound: null, urgency: 'low' }

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function minutesOf(value: string): number | null {
  const match = TIME_RE.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Inclusive of the start, exclusive of the end, and correct across midnight.
 *
 * A window it cannot parse is no window at all: a hand-edited config must not
 * be able to mute the app permanently in a way nothing explains.
 */
export function inQuietHours(
  quietHours: { from: string; to: string } | null,
  now: Date,
): boolean {
  if (!quietHours) return false
  const from = minutesOf(quietHours.from)
  const to = minutesOf(quietHours.to)
  if (from === null || to === null) return false

  const minutes = now.getHours() * 60 + now.getMinutes()
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

function matches(rule: Rule, input: ResolveInput): boolean {
  // A rule with no `on` matches every state, per the parent spec.
  if (rule.on !== undefined && rule.on !== input.state) return false
  if (rule.project !== undefined && rule.project !== input.projectId) return false
  return true
}

function apply(outcome: NotificationOutcome, rule: Rule): NotificationOutcome {
  return {
    // Each field is overridden only by a rule that states it, so a later rule
    // turning a toast off does not also silence the sound an earlier one set.
    toast: rule.toast ?? outcome.toast,
    sound: rule.sound !== undefined ? rule.sound : outcome.sound,
    urgency: rule.urgency ?? outcome.urgency,
  }
}

/**
 * What to do about a transition.
 *
 * Two orderings from the parent spec are in play, and they interact: *later
 * rules override earlier*, and *project-scoped beats global*. Both hold
 * because globals are folded first, in array order, and project-scoped rules
 * second, also in array order. A project rule therefore wins wherever it sits
 * in the file, and two project rules still resolve later-wins between
 * themselves.
 *
 * Pure, and passed its own clock: quiet hours are testable at any hour.
 */
export function resolve(config: NotificationConfig, input: ResolveInput): NotificationOutcome {
  if (inQuietHours(config.quietHours, input.now)) return SILENT

  const relevant = config.rules.filter((rule) => matches(rule, input))
  const global = relevant.filter((rule) => rule.project === undefined)
  const scoped = relevant.filter((rule) => rule.project !== undefined)

  let outcome = SILENT
  for (const rule of [...global, ...scoped]) outcome = apply(outcome, rule)

  // The single largest noise reduction at twelve live sessions: no popup for
  // the pane already in front of you. The sound stays — a chime for the tab
  // you are looking at is the cheapest possible signal, and it is the popup
  // that is redundant.
  if (config.muteWhenFocused && input.attended) outcome = { ...outcome, toast: false }

  return outcome
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/rules.test.ts`

Expected: PASS, 18 tests.

- [ ] **Step 5: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint`

```bash
git add src/main/notify/rules.ts tests/unit/rules.test.ts
git commit -m "$(cat <<'EOF'
Decide what a transition is worth interrupting for

Pure: no Electron, no audio, and its own clock passed in, so quiet hours
are testable without waiting for 10pm.

Two orderings from the parent spec interact — later rules override
earlier, and project-scoped beats global. Both hold because globals fold
first in array order and project-scoped rules second, also in array
order: a project rule wins wherever it sits in the file, and two project
rules still resolve later-wins between themselves. Spelled out because a
reader will otherwise assume one of the two was forgotten.

Each field is overridden only by a rule that states it, so a later rule
turning a toast off does not also silence a sound an earlier one set.

muteWhenFocused drops the toast and keeps the sound. A popup for the
pane already in front of you is redundant; a chime is the cheapest
signal there is.

An unparseable quiet-hours window is no window. A hand-edited config
must not be able to mute the app permanently in a way nothing explains.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Toasts, sounds and the dock badge

The impure half. It resolves a transition through Task 12, then does the three things Electron can do about it.

The dock badge is the part that works with the window hidden behind a browser, which is most of the day — so it is driven off the registry directly rather than off a rule, and shows the count of tabs in `waiting`.

**Files:**
- Create: `src/main/notify/router.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/router.test.ts`

**Interfaces:**
- Consumes: `resolve` (Task 12), `StatusRegistry`/`StatusTransition` (Task 11), `ConfigStore`
- Produces:
  - `class NotificationRouter` — `constructor(deps: RouterDeps)`, `handle(transition: StatusTransition): Promise<void>`, `refreshBadge(): void`
  - `interface RouterDeps` — every effect injected, so the unit test needs no Electron

- [ ] **Step 1: Write the failing test**

Create `tests/unit/router.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { NotificationRouter } from '../../src/main/notify/router'
import { DEFAULT_NOTIFICATIONS } from '../../src/main/state/store'
import type { NotificationConfig, TabDescriptor } from '../../src/shared/ipc'

const ID = '0123456789abcdef'

function tab(id = ID): TabDescriptor {
  return {
    id,
    projectSlug: 'lumio',
    cwd: '/tmp',
    tmuxSession: `prcli-lumio-${id}`,
    type: 'claude',
  }
}

function build(overrides: Partial<Parameters<typeof NotificationRouter.prototype.constructor>[0]> = {}) {
  const toasts: { title: string; body: string; tabId: string }[] = []
  const sounds: string[] = []
  const badges: (number | null)[] = []
  const router = new NotificationRouter({
    readConfig: async (): Promise<NotificationConfig> => DEFAULT_NOTIFICATIONS,
    findTab: async () => tab(),
    projectOf: async () => ({ id: 'lumio-id', name: 'Lumio' }),
    isAttended: () => false,
    showToast: (toast) => toasts.push(toast),
    playSound: (sound) => sounds.push(sound),
    setBadge: (count) => badges.push(count),
    waitingCount: () => 0,
    now: () => new Date('2026-07-30T14:00:00'),
    ...overrides,
  })
  return { router, toasts, sounds, badges }
}

describe('NotificationRouter', () => {
  it('shows a toast naming the project and the tab', async () => {
    const { router, toasts } = build()

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toContain('Lumio')
    expect(toasts[0]?.tabId).toBe(ID)
  })

  it('says nothing about a transition no rule covers', async () => {
    const { router, toasts, sounds } = build()

    await router.handle({ tabId: ID, from: 'idle', to: 'thinking' })

    expect(toasts).toEqual([])
    expect(sounds).toEqual([])
  })

  it('plays a sound only when a rule names one', async () => {
    const { router, sounds } = build({
      readConfig: async () => ({
        rules: [{ on: 'waiting', toast: false, sound: 'Funk' }],
        muteWhenFocused: true,
        quietHours: null,
      }),
    })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(sounds).toEqual(['Funk'])
  })

  it('suppresses the toast for the tab being looked at', async () => {
    const { router, toasts } = build({ isAttended: () => true })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(toasts).toEqual([])
  })

  it('updates the dock badge on every transition', async () => {
    const { router, badges } = build({ waitingCount: () => 3 })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(badges).toEqual([3])
  })

  it('clears the badge rather than showing a zero', async () => {
    const { router, badges } = build({ waitingCount: () => 0 })

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle' })

    // A dock badge reading "0" is worse than none: it is a red spot that
    // means nothing needs you.
    expect(badges).toEqual([null])
  })

  it('says nothing about a tab it can no longer find', async () => {
    const { router, toasts, badges } = build({ findTab: async () => null })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    // Resolved against the live tab set at fire time: the tab may have been
    // killed between the event and this.
    expect(toasts).toEqual([])
    // The badge still refreshes — the count is about every other tab too.
    expect(badges).toHaveLength(1)
  })

  it('names Unsorted rather than nothing for a stray', async () => {
    const { router, toasts } = build({
      projectOf: async () => null,
      readConfig: async () => ({
        rules: [{ on: 'crashed', toast: true }],
        muteWhenFocused: true,
        quietHours: null,
      }),
    })

    await router.handle({ tabId: ID, from: 'running', to: 'crashed' })

    expect(toasts[0]?.title).toContain('Unsorted')
  })

  it('survives a failure to read config without taking the transition down', async () => {
    const { router, badges } = build({
      readConfig: async () => {
        throw new Error('disk gone')
      },
    })

    // A notification is the least important thing happening. It must never be
    // able to break the status pipeline behind it.
    await expect(router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })).resolves
      .toBeUndefined()
    expect(badges).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/router.test.ts`

Expected: FAIL — cannot resolve `../../src/main/notify/router`.

- [ ] **Step 3: Write the router**

Create `src/main/notify/router.ts`:

```ts
import type { NotificationConfig, TabDescriptor } from '../../shared/ipc'
import type { StatusTransition } from '../status/registry'
import { resolve } from './rules'

export interface RouterToast {
  title: string
  body: string
  urgency: 'low' | 'high'
  /** Which tab a click should select. */
  tabId: string
}

/**
 * Every effect injected.
 *
 * Not for purity's sake: it means the unit test needs no Electron, no audio
 * device and no dock, and the thing being tested is the decision rather than
 * the plumbing.
 */
export interface RouterDeps {
  readConfig: () => Promise<NotificationConfig>
  findTab: (tabId: string) => Promise<TabDescriptor | null>
  projectOf: (tab: TabDescriptor) => Promise<{ id: string; name: string } | null>
  /** Window focused *and* this is the tab on screen. */
  isAttended: (tabId: string) => boolean
  showToast: (toast: RouterToast) => void
  playSound: (sound: string) => void
  /** Null clears it. */
  setBadge: (count: number | null) => void
  waitingCount: () => number
  now: () => Date
}

const LABELS: Record<string, string> = {
  waiting: 'needs you',
  crashed: 'crashed',
  idle: 'finished',
  ended: 'exited',
  thinking: 'working',
  running: 'running',
  unknown: 'unknown',
}

export class NotificationRouter {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * React to one transition.
   *
   * Never throws. A notification is the least important thing happening at any
   * given moment, and it must not be able to take down the status pipeline
   * behind it — so a failure to read config costs a toast, not a dot.
   */
  async handle(transition: StatusTransition): Promise<void> {
    try {
      await this.notify(transition)
    } catch {
      // Deliberately swallowed. See above.
    } finally {
      // Always, even when the rest failed: the count is about every other tab
      // as much as this one.
      this.refreshBadge()
    }
  }

  private async notify(transition: StatusTransition): Promise<void> {
    // Resolved against the live tab set at fire time — the tab may have been
    // killed between the event arriving and this running.
    const tab = await this.deps.findTab(transition.tabId)
    if (!tab) return

    const project = await this.deps.projectOf(tab)
    const config = await this.deps.readConfig()
    const outcome = resolve(config, {
      state: transition.to,
      projectId: project?.id ?? null,
      attended: this.deps.isAttended(transition.tabId),
      now: this.deps.now(),
    })

    if (outcome.sound) this.deps.playSound(outcome.sound)
    if (!outcome.toast) return

    this.deps.showToast({
      // A stray still gets a name: "Unsorted" is where it is, and a toast that
      // named nothing would be a toast you cannot act on.
      title: `${project?.name ?? 'Unsorted'} · ${tab.id.slice(0, 6)}`,
      body: LABELS[transition.to] ?? transition.to,
      urgency: outcome.urgency,
      tabId: tab.id,
    })
  }

  /** A badge reading "0" is worse than none: a red spot meaning nothing. */
  refreshBadge(): void {
    const count = this.deps.waitingCount()
    this.deps.setBadge(count > 0 ? count : null)
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/router.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Wire it into the app**

In `src/main/index.ts`, build the router from real Electron effects and connect it to the registry. Add near the top:

```ts
import { execFile } from 'node:child_process'
import { Notification } from 'electron'
import { StatusRegistry } from './status/registry'
import { NotificationRouter } from './notify/router'
import { ConfigStore } from './state/store'
import { describeProjects } from './ipc/restore'
```

and after the registry is constructed:

```ts
const store = new ConfigStore(ConfigStore.defaultPath())

/** The tab the renderer last said was selected — half of "attended". */
let attendedTabId: string | null = null
export function setAttendedTab(id: string | null): void {
  attendedTabId = id
}

const router = new NotificationRouter({
  readConfig: async () => (await store.read()).notifications,
  findTab: async (tabId) => manager.get(tabId) ?? null,
  projectOf: async (tab) => {
    const config = await store.read()
    const project = config.projects.find((candidate) => candidate.slug === tab.projectSlug)
    return project ? { id: project.id, name: project.name } : null
  },
  // Both halves: the window has focus *and* this is the tab on screen. A
  // background tab going `waiting` still toasts while the window is focused,
  // which at twelve sessions is the common case.
  isAttended: (tabId) =>
    mainWindow?.isFocused() === true && attendedTabId === tabId,
  showToast: (toast) => {
    const notification = new Notification({
      title: toast.title,
      body: toast.body,
      // Sound is played separately through afplay, so the rules engine's
      // choice is the only thing that makes noise.
      silent: true,
    })
    notification.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      // `focus()` alone does not reliably bring the app forward on macOS.
      app.focus({ steal: true })
      mainWindow.webContents.send(CHANNELS.focusTab, toast.tabId)
    })
    notification.show()
  },
  playSound: (sound) => {
    // Fire and forget: a missing sound file must not throw into a transition.
    execFile('/usr/bin/afplay', [`/System/Library/Sounds/${sound}.aiff`], () => undefined)
  },
  setBadge: (count) => {
    app.dock?.setBadge(count === null ? '' : String(count))
  },
  waitingCount: () => registry.waitingCount(),
  now: () => new Date(),
})

registry.onTransition((transition) => void router.handle(transition))
```

with `CHANNELS` imported from `../shared/ipc`.

Then have `register.ts` keep `attendedTabId` current. In its `CHANNELS.setActive` handler, before the `serialise` call:

```ts
    onActiveTabChanged(id)
```

where `onActiveTabChanged` is a new optional parameter on `registerIpc`, defaulted to a no-op, and passed `setAttendedTab` from `index.ts`. Adding a parameter rather than importing `index.ts` from `register.ts` keeps the dependency pointing one way — `register.ts` is constructed by `index.ts`, and an import back would be a cycle.

Also pass the same `store` instance into `registerIpc` so the router and the IPC handlers read one file through one object:

```ts
registerIpc(manager, () => mainWindow, registry, store, setAttendedTab)
```

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npm test && npm run lint && npm run e2e`

Expected: all clean; 22 E2E still passing.

- [ ] **Step 7: Confirm the developer's tmux server is untouched, then commit**

Run: `tmux ls` and compare against the captured list.

```bash
git add -A
git commit -m "$(cat <<'EOF'
Interrupt the user, when a rule says to

The impure half of notifications: resolve a transition through the rules
engine, then do the three things Electron can do about it.

Every effect is injected. Not for purity — it means the test needs no
Electron, no audio device and no dock, and what is tested is the
decision rather than the plumbing.

handle() never throws. A notification is the least important thing
happening at any moment and must not be able to take down the status
pipeline behind it, so a failed config read costs a toast and not a dot.
The badge refreshes in a finally, because the count is about every other
tab as much as this one.

The dock badge is the signal that works with the window hidden behind a
browser, which is most of the day, so it is driven off the registry
rather than off a rule. It clears rather than showing a zero: a badge
reading "0" is a red spot meaning nothing needs you.

"Attended" is both halves — the window has focus and this is the tab on
screen. A background tab going waiting still toasts while the window is
focused, which at twelve sessions is the common case.

A clicked toast uses app.focus({ steal: true }); mainWindow.focus()
alone does not reliably bring the app forward on macOS. That is the
carried-forward note from the second-instance handler, discharged here
because this is the second place that needs it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Status and tombstones in the renderer's state

The reducer gains two things: a map of tab states, and the dead tabs that used to vanish.

**This changes shipped behaviour.** `App.tsx` currently dispatches `removed` on any exit with `sessionAlive: false`, which is why `crashed` is a state that can never be rendered. A dead tab now stays in the bar with its scrollback readable until the user restarts or dismisses it.

The tombstones are renderer-side only. Main already forgets the row on exit and config is written from live state, so a dead tab never reaches disk and a relaunch prunes it exactly as today — which is why none of this needs a migration.

**Files:**
- Modify: `src/renderer/workspace.ts`
- Create: `src/renderer/StatusDot.tsx`
- Test: `tests/unit/workspace.test.ts` (modify)

**Interfaces:**
- Consumes: `TabState`, `worst` from `src/shared/status.ts`
- Produces:
  - `WorkspaceState.status: Record<string, TabState>`, `WorkspaceState.dead: Record<string, number>` (exit code by tab id)
  - Actions `statusSnapshot`, `statusChanged`, `died`, `dismissed`
  - `stateOfTab(state, id): TabState | null`, `stateOfProject(state, projectId): TabState | null`, `needsYou(state): TabDescriptor[]`
  - `StatusDot({ state, testid })`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/workspace.test.ts`. Keep every existing test exactly as it is — the M2a cases ported into this file still describe real behaviour.

```ts
  it('takes a whole status snapshot on restore', () => {
    const next = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'waiting' },
    })
    expect(stateOfTab(next, 'aaa')).toBe('waiting')
  })

  it('updates one tab without disturbing the others', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'idle', 'bbb': 'thinking' },
    })

    const next = workspaceReducer(seeded, {
      type: 'statusChanged',
      tabId: 'aaa',
      state: 'waiting',
    })

    expect(stateOfTab(next, 'aaa')).toBe('waiting')
    expect(stateOfTab(next, 'bbb')).toBe('thinking')
  })

  it('has no state for a tab nothing has said anything about', () => {
    expect(stateOfTab(three, 'aaa')).toBeNull()
  })

  it('gives a project row the worst state among its tabs', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'idle', 'bbb': 'waiting' },
    })

    expect(stateOfProject(seeded, 'id-lumio')).toBe('waiting')
  })

  it('gives a project with nothing to report no dot at all', () => {
    expect(stateOfProject(three, 'id-lumio')).toBeNull()
  })

  it('lists every tab that is blocking a human, worst first', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: {
        'aaa': 'waiting',
        'bbb': 'crashed',
        'ccc': 'thinking',
      },
    })

    const list = needsYou(seeded)

    // Only the two states that mean a human is required, and the crash first.
    expect(list.map((tab) => tab.id)).toEqual(['bbb', 'aaa'])
  })

  it('keeps a dead tab in the bar instead of dropping it', () => {
    const next = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })

    // The behaviour this milestone changes: a crashed `npm run dev` used to
    // vanish and tell you nothing, which made `crashed` unrenderable.
    expect(next.tabs.some((tab) => tab.id === 'aaa')).toBe(true)
    expect(next.dead['aaa']).toBe(1)
  })

  it('leaves the selection on a tab that died, so its scrollback stays readable', () => {
    const selected = workspaceReducer(three, { type: 'activatedTab', id: 'aaa' })
    const next = workspaceReducer(selected, { type: 'died', id: 'aaa', code: 1 })

    expect(activeTabId(next)).toBe('aaa')
  })

  it('drops the tab and its tombstone on dismiss', () => {
    const died = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })

    const next = workspaceReducer(died, { type: 'dismissed', id: 'aaa' })

    expect(next.tabs.some((tab) => tab.id === 'aaa')).toBe(false)
    expect(next.dead['aaa']).toBeUndefined()
  })

  it('moves the selection to a neighbour on dismiss, as a close does', () => {
    const selected = workspaceReducer(three, { type: 'activatedTab', id: 'aaa' })
    const died = workspaceReducer(selected, { type: 'died', id: 'aaa', code: 1 })

    const next = workspaceReducer(died, { type: 'dismissed', id: 'aaa' })

    expect(activeTabId(next)).not.toBe('aaa')
  })

  it('clears the tombstone when a dead tab is restarted', () => {
    const died = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })
    const tab = died.tabs.find((candidate) => candidate.id === 'aaa')
    if (!tab) throw new Error('fixture lost the tab')

    const next = workspaceReducer(died, { type: 'opened', tab })

    // Restart reuses the id. A tombstone left behind would keep offering
    // Restart on a session that is already running.
    expect(next.dead['aaa']).toBeUndefined()
    expect(next.tabs.filter((candidate) => candidate.id === 'aaa')).toHaveLength(1)
  })

  it('drops the status of a tab that is closed outright', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'waiting' },
    })

    const next = workspaceReducer(seeded, { type: 'removed', id: 'aaa' })

    expect(stateOfTab(next, 'aaa')).toBeNull()
  })
```

Add the new imports (`stateOfTab`, `stateOfProject`, `needsYou`) and reuse the file's existing `three` fixture, whose tabs are `'aaa'`, `'bbb'`, `'ccc'` under project `'p1'`.

**Do not lengthen those ids to 16 hex.** They are short on purpose and every existing assertion in the file names them; changing them would mean rewriting tests this task has no business touching. The reducer does not validate id format — only `parseHookLine` and the tmux name codec do, and neither is involved here.

The `three` fixture will need `status: {}` and `dead: {}` added to it, since `WorkspaceState` gains both. That is a fixture completion, not an assertion change.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/workspace.test.ts`

Expected: the new cases FAIL; every existing case still passes.

- [ ] **Step 3: Extend the reducer**

In `src/renderer/workspace.ts`, add to the state and actions:

```ts
export interface WorkspaceState {
  projects: ProjectDescriptor[]
  tabs: TabDescriptor[]
  activeProjectId: string | null
  /** What each tab is doing. A tab absent from this draws no dot. */
  status: Record<string, TabState>
  /**
   * Tabs whose tmux session has died, by exit code, kept in the bar until the
   * user restarts or dismisses them.
   *
   * Renderer-side only: main forgot the row when the session died and config
   * is written from live state, so none of this reaches disk and a relaunch
   * prunes it exactly as it always has. That is what makes tombstones free of
   * any migration.
   */
  dead: Record<string, number>
}
```

```ts
  | { type: 'statusSnapshot'; status: Record<string, TabState> }
  | { type: 'statusChanged'; tabId: string; state: TabState }
  | { type: 'died'; id: string; code: number }
  | { type: 'dismissed'; id: string }
```

```ts
export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  tabs: [],
  activeProjectId: null,
  status: {},
  dead: {},
}
```

Add the selectors below the existing ones:

```ts
/** Null means "draw no dot", which is not the same as `unknown`. */
export function stateOfTab(state: WorkspaceState, id: string): TabState | null {
  return state.status[id] ?? null
}

/** A project row takes the worst state among its tabs. */
export function stateOfProject(state: WorkspaceState, projectId: string): TabState | null {
  const states = tabsOfProject(state, projectId)
    .map((tab) => state.status[tab.id])
    .filter((candidate): candidate is TabState => candidate !== undefined)
  return worst(states)
}

/**
 * Every tab that is blocking a human, worst first.
 *
 * `waiting` and `crashed` only: those are the two states that mean someone has
 * to do something. A list that also held `thinking` would be a list of
 * everything, which is the sidebar you already have.
 */
export function needsYou(state: WorkspaceState): TabDescriptor[] {
  const ranked = state.tabs.filter((tab) => {
    const status = state.status[tab.id]
    return status === 'waiting' || status === 'crashed'
  })
  return ranked.sort((left, right) => {
    const order = (tab: TabDescriptor): number => (state.status[tab.id] === 'crashed' ? 0 : 1)
    return order(left) - order(right)
  })
}
```

with `import { worst, type TabState } from '../shared/status'`.

Add the cases to the reducer:

```ts
    case 'statusSnapshot':
      return { ...state, status: action.status }

    case 'statusChanged':
      return { ...state, status: { ...state.status, [action.tabId]: action.state } }

    case 'died':
      // Deliberately keeps the tab, and keeps it selected. Its scrollback is
      // the only record of why it died, and dropping it is what made `crashed`
      // a state nothing could ever render.
      return { ...state, dead: { ...state.dead, [action.id]: action.code } }

    case 'dismissed': {
      const { [action.id]: _dropped, ...dead } = state.dead
      // Same selection move a close makes, so dismissing the tab you are
      // looking at does not leave the pane showing nothing.
      return { ...removeTab(state, action.id), dead }
    }
```

The existing `removed` case and the new `dismissed` case share the tab-removal and selection logic; factor the body of `removed` into a `removeTab(state, id)` helper and have both call it, rather than writing the neighbour rule twice. `removed` additionally drops the status entry:

```ts
    case 'removed': {
      const { [action.id]: _dropped, ...status } = state.status
      return { ...removeTab(state, action.id), status }
    }
```

And extend `opened` to clear a tombstone, since restart reuses the id:

```ts
    case 'opened': {
      const { [action.tab.id]: _revived, ...dead } = state.dead
      const existing = state.tabs.some((tab) => tab.id === action.tab.id)
      const owner = projectIdForTab(state.projects, action.tab)
      return setActiveTab(
        {
          ...state,
          // Replaced in place on a restart, appended on a genuine open. A
          // plain append would leave two rows for one session.
          tabs: existing
            ? state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab))
            : [...state.tabs, action.tab],
          dead,
        },
        owner,
        action.tab.id,
      )
    }
```

Note this replaces the old early return for a duplicate id. That early return existed to stop a double-open adding a second row; replacing in place does the same job and additionally makes restart work.

- [ ] **Step 4: Write the dot**

Create `src/renderer/StatusDot.tsx`:

```tsx
import type { TabState } from '../shared/status'
import { cn } from './lib/cn'

/**
 * The only place a state becomes a colour.
 *
 * `unknown` is drawn hollow — a ring, not a fill — because it means "this
 * should have a state and does not", which is what a claude tab with a broken
 * hook install looks like. A tab with no state at all draws nothing, which is
 * why the caller passes null rather than a seventh colour.
 */
const STYLES: Record<TabState, string> = {
  crashed: 'bg-danger',
  waiting: 'bg-amber-400',
  thinking: 'bg-sky-400',
  running: 'bg-accent',
  idle: 'bg-muted',
  ended: 'bg-faint',
  unknown: 'border border-faint bg-transparent',
}

export function StatusDot({ state, testid }: { state: TabState | null; testid?: string }) {
  if (!state) return null
  return (
    <span
      data-testid={testid}
      data-state={state}
      aria-label={state}
      title={state}
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', STYLES[state])}
    />
  )
}
```

- [ ] **Step 5: Run the tests, then everything**

Run: `npx vitest run tests/unit/workspace.test.ts`

Expected: PASS, including all previously existing cases.

Run: `npm run typecheck && npm test && npm run lint`

Expected: clean. `App.tsx` still compiles — it does not yet dispatch the new actions, which Task 15 does.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/workspace.ts src/renderer/StatusDot.tsx tests/unit/workspace.test.ts
git commit -m "$(cat <<'EOF'
Hold status and dead tabs in the workspace state

Two additions to the reducer: what each tab is doing, and the dead tabs
that used to vanish.

A tab whose session dies now stays in the bar, still selected, with its
scrollback readable. Dropping it is what made `crashed` a state nothing
could ever render — a queue worker that died told you nothing at all,
which is most of the reason a preset tab wants a dot.

The tombstones are renderer-side only. Main forgot the row when the
session died and config is written from live state, so none of this
reaches disk and a relaunch prunes it exactly as it always has. That is
what makes them free of any migration.

`opened` now replaces in place rather than early-returning on a
duplicate id, and clears the tombstone. Restart reuses the id, so the
old early return would have left a dead row beside a live session.

needsYou lists `waiting` and `crashed` only — the two states that mean
someone has to do something. A list that also held `thinking` would be a
list of everything, which is the sidebar you already have.

StatusDot is the only place a state becomes a colour, and draws
`unknown` hollow: a ring means "should have a state and does not", which
is what a broken hook install looks like.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Dots on screen

Where the milestone becomes visible. Dots in the tab bar and the sidebar, a "Needs you" list pinned above the project tree, and Restart / Dismiss on a dead tab.

**Files:**
- Create: `src/renderer/NeedsYou.tsx`
- Modify: `src/renderer/TabBar.tsx`, `src/renderer/Sidebar.tsx`, `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `StatusDot` and the selectors from Task 14; `restartTab`, `dismissTab`, `onStatus`, `onFocusTab`, `status` from Task 11
- Produces: no new exports — this is wiring

- [ ] **Step 1: Add the Needs You list**

Create `src/renderer/NeedsYou.tsx`:

```tsx
import type { ProjectDescriptor, TabDescriptor } from '../shared/ipc'
import type { TabState } from '../shared/status'
import { StatusDot } from './StatusDot'
import { projectIdForTab } from './workspace'

/**
 * The global list of everything blocking a human, pinned above the project
 * tree. At twelve sessions across five customers this is the answer to the
 * question the app exists for, without expanding anything.
 *
 * Absent entirely when nothing needs you — an empty "Needs you" heading is a
 * thing to check, and the point is not having to.
 */
export function NeedsYou({
  tabs,
  projects,
  status,
  onSelect,
}: {
  tabs: TabDescriptor[]
  projects: ProjectDescriptor[]
  status: Record<string, TabState>
  onSelect: (tab: TabDescriptor) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div data-testid="needs-you" className="border-b border-border pb-1">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        <span>Needs you</span>
        <span data-testid="needs-you-count" className="text-amber-400">
          {tabs.length}
        </span>
      </div>
      {tabs.map((tab) => {
        const project = projects.find(
          (candidate) => candidate.id === projectIdForTab(projects, tab),
        )
        return (
          <button
            key={tab.id}
            data-testid={`needs-${tab.id}`}
            onClick={() => onSelect(tab)}
            className="flex w-full cursor-default items-center gap-1.5 border-none bg-transparent px-2.5 py-0.5 text-left text-muted hover:text-fg"
          >
            <StatusDot state={status[tab.id] ?? null} testid={`ndot-${tab.id}`} />
            <span className="truncate">
              {project?.name ?? 'Unsorted'} · {tab.id.slice(0, 6)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Put dots and dead-tab actions in the tab bar**

In `src/renderer/TabBar.tsx`, take three new props — `status: Record<string, TabState>`, `dead: Record<string, number>`, `onRestart: (tab: TabDescriptor) => void`, `onDismiss: (id: string) => void` — and inside the tab element:

```tsx
            <StatusDot state={status[tab.id] ?? null} testid={`dot-${tab.id}`} />
            <span className={cn(dead[tab.id] !== undefined && 'line-through opacity-60')}>
              {label(tab)}
            </span>
            {dead[tab.id] !== undefined ? (
              <>
                {/* A dead tab keeps its scrollback and offers the two things
                    worth doing with it. Restart recreates the session under
                    the same id, cwd, command and type. */}
                <button
                  data-testid={`restart-${tab.id}`}
                  aria-label={`Restart ${label(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRestart(tab)
                  }}
                  className="cursor-default border-none bg-transparent p-0 text-[10px] text-muted hover:text-fg"
                >
                  ↻
                </button>
                <button
                  data-testid={`dismiss-${tab.id}`}
                  aria-label={`Dismiss ${label(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDismiss(tab.id)
                  }}
                  className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-muted hover:text-fg"
                >
                  ×
                </button>
              </>
            ) : (
              // The close button stays exactly as it was for a live tab —
              // closing kills, and killing a dead session has nothing to do.
              <button data-testid={`close-${tab.id}`} …unchanged… />
            )}
```

Keep the existing `close-` button markup verbatim inside the `else` branch. Its testid, aria-label and stopPropagation behaviour are all asserted by the shipped E2E suites.

- [ ] **Step 3: Put dots in the sidebar**

In `src/renderer/Sidebar.tsx`, take `status`, `projectStateOf: (projectId: string) => TabState | null`, and `needsYou`/`onSelectNeedy` props. Render `<NeedsYou … />` above the `Projects` heading, a `<StatusDot state={projectStateOf(project.id)} testid={`pdot-${project.id}`} />` in the project row before the name, and a `<StatusDot state={status[tab.id] ?? null} testid={`sdot-${tab.id}`} />` in each tab row.

Add a mute toggle to the project menu, since the rules engine already honours a project-scoped rule:

```tsx
                  <MenuItem
                    testid={`pmute-${project.id}`}
                    label={muted ? 'Unmute project' : 'Mute project'}
                    onClick={() => {
                      setMenuFor(null)
                      onToggleMute(project.id)
                    }}
                  />
```

with `muted: (projectId: string) => boolean` and `onToggleMute: (projectId: string) => void` as props.

- [ ] **Step 4: Wire it in App**

In `src/renderer/App.tsx`:

Load the snapshot on restore, so a ⌘R comes back with the board intact:

```tsx
      const [{ projects, tabs, activeProjectId }, status] = await Promise.all([
        window.prcli.restore(),
        window.prcli.status(),
      ])
      if (cancelled) return
      dispatch({ type: 'restored', projects, tabs, activeProjectId })
      dispatch({ type: 'statusSnapshot', status })
      setReady(true)
```

Subscribe to changes:

```tsx
  useEffect(
    () =>
      window.prcli.onStatus(({ tabId, state }) =>
        dispatch({ type: 'statusChanged', tabId, state }),
      ),
    [],
  )
```

Replace the exit handler's `removed` with `died`:

```tsx
  useEffect(
    () =>
      window.prcli.onExit(({ id, code, sessionAlive }) => {
        // Still the same rule: a client stopping is not a session dying, and a
        // detach arrives here with the session running. What changes is what a
        // real death does — the tab stays, marked dead, instead of vanishing.
        if (sessionAlive) return
        dispatch({ type: 'died', id, code })
      }),
    [],
  )
```

Follow a clicked toast:

```tsx
  useEffect(
    () =>
      window.prcli.onFocusTab((tabId) => {
        const tab = state.tabs.find((candidate) => candidate.id === tabId)
        if (!tab) return
        dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
        dispatch({ type: 'activatedTab', id: tabId })
      }),
    [state.tabs, state.projects],
  )
```

And add the two handlers:

```tsx
  const restartTab = useCallback(
    (tab: TabDescriptor) => {
      window.prcli
        .restartTab({ tab })
        .then((restarted) => dispatch({ type: 'opened', tab: restarted }))
        .catch(fail)
    },
    [fail],
  )

  const dismissTab = useCallback((id: string) => {
    window.prcli.dismissTab(id)
    dispatch({ type: 'dismissed', id })
  }, [])
```

`restartTab` sends no explicit geometry: the tab's `Terminal` is still mounted, its last `resize` is what `register.ts` remembered, and the fit that follows the reattach corrects anything stale. Say so in a comment where the call is made, because the global constraint says every new attach path must carry geometry and a reader needs to see that it does.

For the mute toggle, `muted` is `project.presets`-independent — it reads the notification rules, so `App` needs them. Fetch once alongside status and keep them in component state; toggling writes through `updateNotifications` (Task 16) and stores what comes back.

- [ ] **Step 5: Verify by eye and by suite**

Run: `npm run typecheck && npm test && npm run lint && npm run e2e`

Expected: all clean, 22 E2E still passing. If a shipped E2E fails, **read it before changing anything** — it is asserting behaviour this task may have broken, and the assertion is more likely right than the change.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Draw the dots

Tab bar, sidebar and a Needs You list pinned above the project tree —
the answer to the question the app exists for, without expanding
anything. Absent entirely when nothing needs you: an empty heading is a
thing to check, and the point is not having to.

A dead tab keeps its place in the bar, struck through, offering Restart
and Dismiss. The close button is untouched for live tabs: closing kills,
and killing a dead session has nothing to do.

The exit handler now dispatches `died` rather than `removed`. The rule
it enforces is unchanged — a client stopping is not a session dying, and
a detach still arrives with the session running — what changes is what a
real death does.

A clicked toast selects the project and then the tab, so it lands on the
pane it named even when that project is not the one on screen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Installing the hooks, from a screen

The gesture. A settings pane showing whether PRCLI's hooks are installed, exactly what would be added, and any `afplay` hook already bound to an event PRCLI subscribes to. Plus the per-state notification rows.

**Nothing here may touch the real `~/.claude/settings.json` in a test.** `PRCLI_CLAUDE_SETTINGS` must be set by every test that can reach this code, and the E2E in Task 17 asserts the file it points at is byte-identical after an uninstall.

**Files:**
- Modify: `src/main/hooks/install.ts`, `src/main/ipc/register.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/App.tsx`
- Create: `src/renderer/SettingsPane.tsx`
- Test: `tests/integration/install.test.ts`

**Interfaces:**
- Produces:
  - `installHooks(): Promise<HooksState>`, `uninstallHooks(): Promise<HooksState>`, `readHooksState(): Promise<HooksState>`
  - `interface HooksState { installed: boolean; settingsPath: string; hookPath: string; pending: string; collisions: { event: string; command: string }[] }`
  - Channels `hooksState`, `installHooks`, `uninstallHooks`, `notifications`, `updateNotifications`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/install.test.ts`, driving the real functions against a temp `PRCLI_CLAUDE_SETTINGS` and `PRCLI_CONFIG_DIR`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks, readHooksState, uninstallHooks } from '../../src/main/hooks/install'

let dir: string
let settings: string
const saved = { config: process.env.PRCLI_CONFIG_DIR, claude: process.env.PRCLI_CLAUDE_SETTINGS }

const ORIGINAL = {
  model: 'opusplan',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
  },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-inst-'))
  settings = join(dir, 'settings.json')
  await writeFile(settings, `${JSON.stringify(ORIGINAL, null, 2)}\n`, 'utf8')
  process.env.PRCLI_CONFIG_DIR = dir
  process.env.PRCLI_CLAUDE_SETTINGS = settings
})

afterEach(async () => {
  process.env.PRCLI_CONFIG_DIR = saved.config
  process.env.PRCLI_CLAUDE_SETTINGS = saved.claude
  await rm(dir, { recursive: true, force: true })
})

describe('installHooks', () => {
  it('reports not installed, and what it would add, before anything happens', async () => {
    const state = await readHooksState()

    expect(state.installed).toBe(false)
    expect(state.pending).toContain('prcli-hook')
    // The diff the screen shows comes from the same merge that writes.
    expect(JSON.parse(state.pending)).toBeTypeOf('object')
  })

  it('names an existing afplay hook as a sound collision', async () => {
    const state = await readHooksState()
    expect(state.collisions.map((c) => c.event)).toEqual(['Stop'])
  })

  it('writes a timestamped backup before touching the file', async () => {
    await installHooks()

    const backups = (await readdir(dir)).filter((name) => name.startsWith('settings.json.'))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, backups[0] ?? ''), 'utf8'))).toEqual(ORIGINAL)
  })

  it('installs the script, executable', async () => {
    const state = await installHooks()

    const info = await stat(state.hookPath)
    expect(info.isFile()).toBe(true)
    // Claude executes this directly; a non-executable file fails every hook.
    expect(info.mode & 0o111).toBeGreaterThan(0)
    expect(await readFile(state.hookPath, 'utf8')).toContain('#!/bin/sh')
  })

  it('is idempotent', async () => {
    await installHooks()
    const after = await readFile(settings, 'utf8')

    const state = await installHooks()

    expect(state.installed).toBe(true)
    expect(await readFile(settings, 'utf8')).toBe(after)
  })

  it('restores the original file on uninstall', async () => {
    await installHooks()

    const state = await uninstallHooks()

    expect(state.installed).toBe(false)
    // Byte-for-byte the object it found. This is the assertion that protects
    // every other Claude session on the machine.
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual(ORIGINAL)
  })

  it('refuses a settings file it cannot parse, and writes nothing', async () => {
    await writeFile(settings, '{ not json', 'utf8')

    await expect(installHooks()).rejects.toThrow()

    expect(await readFile(settings, 'utf8')).toBe('{ not json')
  })

  it('creates a settings file when there is none', async () => {
    await rm(settings, { force: true })

    const state = await installHooks()

    expect(state.installed).toBe(true)
    expect(JSON.parse(await readFile(settings, 'utf8')).hooks).toBeTypeOf('object')
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `npx vitest run tests/integration/install.test.ts` — FAIL, functions not exported.

Add to `src/main/hooks/install.ts`:

```ts
import { chmod, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'

export interface HooksState {
  installed: boolean
  settingsPath: string
  hookPath: string
  /** The JSON that would be added, for the screen to show before it happens. */
  pending: string
  collisions: { event: string; command: string }[]
}

/**
 * Read the settings file, or `{}` when there is none.
 *
 * A file that exists and does not parse throws rather than being treated as
 * empty: overwriting an unparseable settings.json with a fresh one would
 * destroy whatever the user actually had in it, which is the single worst
 * thing this module could do.
 */
async function readSettings(path: string): Promise<ClaudeSettings> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  return asSettings(JSON.parse(raw))
}

export async function readHooksState(): Promise<HooksState> {
  const settingsPath = claudeSettingsPath()
  const { script } = hookPaths()
  const settings = await readSettings(settingsPath).catch(() => ({}) as ClaudeSettings)
  const { next } = merge(settings, script)
  return {
    installed: isInstalled(settings, script),
    settingsPath,
    hookPath: script,
    pending: JSON.stringify(next.hooks, null, 2),
    collisions: soundCollisions(settings),
  }
}

export async function installHooks(): Promise<HooksState> {
  const settingsPath = claudeSettingsPath()
  const paths = hookPaths()

  // Parse before anything is written: a settings file we cannot read is a
  // settings file we must not replace.
  const settings = await readSettings(settingsPath)

  await mkdir(dirname(paths.script), { recursive: true })
  // Rewritten every install, so an upgrade cannot leave an old copy behind.
  await writeFile(paths.script, renderScript(paths), 'utf8')
  await chmod(paths.script, 0o755)

  const { next, added } = merge(settings, paths.script)
  if (added.length > 0) {
    // Timestamp rather than a single `.bak`: a second install a week later
    // must not overwrite the copy that predates PRCLI entirely.
    await copyFile(settingsPath, `${settingsPath}.${Date.now()}.bak`).catch(() => undefined)
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }
  return readHooksState()
}

export async function uninstallHooks(): Promise<HooksState> {
  const settingsPath = claudeSettingsPath()
  const { script } = hookPaths()
  const settings = await readSettings(settingsPath)
  const { next, removed } = unmerge(settings, script)
  if (removed.length > 0) {
    await copyFile(settingsPath, `${settingsPath}.${Date.now()}.bak`).catch(() => undefined)
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }
  // The script itself stays on disk. It exits 0 with nothing installed, and
  // leaving it means a reinstall is one click rather than a reinstall.
  return readHooksState()
}
```

with `dirname` added to the `node:path` import.

- [ ] **Step 3: Add the channels**

`CHANNELS`: `hooksState`, `installHooks`, `uninstallHooks`, `notifications`, `updateNotifications`. `PrcliApi`: the five matching methods, returning `HooksState` and `NotificationConfig`. Preload: `invoke` for all five.

In `register.ts`:

```ts
  ipcMain.handle(CHANNELS.hooksState, () => readHooksState())
  ipcMain.handle(CHANNELS.installHooks, () => installHooks())
  ipcMain.handle(CHANNELS.uninstallHooks, () => uninstallHooks())

  ipcMain.handle(CHANNELS.notifications, async () => (await store.read()).notifications)

  ipcMain.handle(
    CHANNELS.updateNotifications,
    (_event, patch: Partial<NotificationConfig>): Promise<NotificationConfig> =>
      serialise(async () => {
        const config = await store.read()
        const notifications = { ...config.notifications, ...patch }
        await store.write({ ...config, notifications })
        return notifications
      }),
  )
```

`installHooks` and `uninstallHooks` write `~/.claude/settings.json`, not PRCLI's config, so they do **not** go through `serialise` — and must not, since nothing inside that queue may re-enter it.

- [ ] **Step 4: Build the pane**

Create `src/renderer/SettingsPane.tsx` over the existing `ui/Dialog.tsx`, with:

- A hooks row: `data-testid="hooks-status"` showing `installed` / `not installed`, `hooks-install` and `hooks-uninstall` buttons, a `<pre data-testid="hooks-pending">` showing `state.pending`, and a `hooks-collisions` block listing each collision as `<event> already runs <command>` with a line explaining that PRCLI's own sounds ship off for that reason.
- One row per state in `['waiting', 'crashed', 'idle', 'thinking', 'running', 'ended']`: a toast checkbox (`rule-toast-<state>`), a sound `<select>` (`rule-sound-<state>`) over `['', 'Funk', 'Glass', 'Basso', 'Ping', 'Submarine']`, and an urgency `<select>` (`rule-urgency-<state>`).
- A `mute-when-focused` checkbox.

Editing a row rewrites that state's **global** rule in the array — replacing the existing `{ on: state, project: undefined }` rule or appending one — and sends the whole `rules` array through `updateNotifications`. Project-scoped rules are never touched by this pane; they are written only by the sidebar's mute toggle, which appends or removes `{ on: undefined, project: id, toast: false }`.

Open it from a `settings-open` button at the foot of the sidebar and from ⌘, in `App.tsx`'s existing keydown handler (`event.code === 'Comma'`), and add a `Settings…` item with accelerator `CmdOrCtrl+,` and `registerAccelerator: false` to the app menu in `src/main/index.ts`, matching the shape of the existing New Tab / Close Tab entries.

- [ ] **Step 5: Run everything and commit**

Run: `npm run typecheck && npm test && npm run lint && npm run e2e`

Then confirm your own settings file was not touched:

Run: `ls -la ~/.claude/settings.json*`

Expected: no `.bak` files created by the test run, and the mtime unchanged. **If any `settings.json.<timestamp>.bak` exists that you did not expect, stop and report it** — it means a test reached the real file.

```bash
git add -A
git commit -m "$(cat <<'EOF'
Install the hooks, from a screen, after showing the diff

Nothing touches ~/.claude/settings.json until the button is pressed. The
screen renders the JSON that would be added from the same merge call
that writes it, so the preview and the write cannot disagree.

A settings file that exists and does not parse throws rather than being
treated as empty. Overwriting an unparseable settings.json with a fresh
one would destroy whatever the user actually had, which is the worst
thing this module could do — and there is a test asserting the bad file
is left exactly as found.

Backups are timestamped, not a single .bak: a second install a week
later must not overwrite the copy that predates PRCLI entirely.

Uninstall leaves the script on disk. It exits 0 with nothing installed,
and leaving it makes a reinstall one click.

The pane also names any afplay hook already bound to an event PRCLI
subscribes to, with a line saying that is why PRCLI's own sounds ship
off. On this machine that is Funk on Notification and Glass on Stop.

installHooks and uninstallHooks deliberately do not go through the
config write queue: they write a different file, and nothing reached
from inside that queue may re-enter it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: The milestone end to end

**Files:**
- Create: `tests/e2e/status.spec.ts`

Model it on `tests/e2e/projects.spec.ts`: `electron.launch` against `.vite/build/main.js` with `PRCLI_CONFIG_DIR`, `PRCLI_TMUX_SOCKET: 'prcli-e2e-status'`, `PRCLI_PROJECTS_ROOT`, and — new and mandatory — `PRCLI_CLAUDE_SETTINGS` pointing at a temp file. Every one of the four must be set, including in tests that never open the settings pane.

Events are injected by connecting to `<configDir>/hook.sock` from the test process and writing lines, which is exactly what the hook script does.

- [ ] **Step 1: Write the suite**

Cover, one test each:

1. **A dot appears for an injected event.** Open a tab, inject `UserPromptSubmit` for its id, assert `dot-<id>` has `data-state="thinking"`; inject `Notification`, assert `waiting`.
2. **The project row takes the worst of its tabs.** Two tabs in one project, one `idle` and one `waiting`; assert `pdot-<projectId>` is `waiting`.
3. **Needs You lists it and clicking it lands on the tab.** Assert `needs-you-count` is 1 and clicking `needs-<id>` selects that project and that tab.
4. **The board survives a reload.** Inject `Notification`, `window.reload()`, assert the dot is still `waiting` — this is what putting the registry in main buys.
5. **The spool replays across a relaunch.** Close the app, append a `Notification` line for a live tab's id to `<configDir>/hook.spool`, relaunch, assert the dot comes back `waiting` and the spool file is gone.
6. **A dead tab lingers and restarts.** Kill the tmux session from the test with `tmux -L prcli-e2e-status kill-session -t '=<name>'`, assert the tab is still present with `data-state="crashed"`, click `restart-<id>`, assert a session with that exact name exists again.
7. **Install and uninstall leave the file identical.** Seed `PRCLI_CLAUDE_SETTINGS` with a fixture holding an unrelated hook, open settings, install, assert the fixture's entry survives and PRCLI's is present, uninstall, assert the parsed file deep-equals the seeded object.

Use `expect.poll` with a 20s timeout for anything involving tmux, matching the existing suites.

- [ ] **Step 2: Run it**

Run: `npm run package && npx playwright test tests/e2e/status.spec.ts`

Expected: 7 passing.

- [ ] **Step 3: Full green, and prove nothing escaped**

Run: `npm run typecheck && npm test && npm run lint && npm run e2e`

Then:

```bash
tmux ls                          # identical to the pre-milestone capture
tmux -L prcli-e2e-status ls      # no server, or no sessions
ls -la ~/.claude/settings.json*  # no unexpected .bak files
ls ~/.prcli                      # untouched by the suite
```

Report all four outputs.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/status.spec.ts
git commit -m "$(cat <<'EOF'
Prove the milestone end to end

Seven tests over the real app: a dot for an injected event, a project
row taking the worst of its tabs, Needs You landing on the right pane, a
reload that does not blank the board, a spool replay across a relaunch,
a killed session lingering as dead and restarting into a live one, and
an install/uninstall cycle that leaves an unrelated hook byte-identical.

Events are injected by writing lines to the socket, which is exactly
what the hook script does. What no automated test can judge is whether
a toast actually appeared or a sound actually played — those join the
manual checklist.

PRCLI_CLAUDE_SETTINGS is set in this suite and every other, including
the ones that never open the settings pane. Same rule as
PRCLI_PROJECTS_ROOT after 2b, and for a file with a great deal more
riding on it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manual checklist — no automated test can judge these

Left for the developer, deliberately:

- A toast actually appears, names the right project and tab, and clicking it brings the app forward and lands on that pane.
- A sound actually plays, once, when a rule names one.
- The dock badge is visible and correct with the window hidden behind a browser.
- Real Claude hooks fire as modelled. Every automated test above uses synthetic events; this is the one thing that proves the wire is real. Run `claude` in a tab, watch the dot go blue on a prompt and amber on a permission request.
- Still outstanding from M1 and M2b, and unaffected by this milestone: the TUI fidelity pass, and a relaunch before touching the running instance.
