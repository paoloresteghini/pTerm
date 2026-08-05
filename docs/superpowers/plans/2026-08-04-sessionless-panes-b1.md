# Sessionless Panes (Slice B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pane that has no tmux session: clicking a file in the tree opens it in its own tab, read-only, and that tab comes back after a relaunch.

**Architecture:** `TabType` gains `'editor'` and `PaneRecord.tmuxSession` becomes optional, so the store can hold a pane with no session. Restore today starts from live tmux and can only ever return panes tmux told it about, so sessionless panes are merged back in by a PURE module that takes the saved config and the live result and returns the union. `FileTree` gets an `onOpenFile`, the pane render branches on `type === 'editor'`, and everything that assumes a pane has a session learns to skip one.

**Tech Stack:** TypeScript, Electron IPC, React, Tailwind v4, vitest (node environment), Playwright (`_electron.launch`).

This plan is slice **B1** of `docs/superpowers/specs/2026-08-04-file-tree-and-editor-design.md`. Slice A (the file tree) is merged at `7f3ca7a`. **CodeMirror is NOT in this plan.** The editor pane here renders read-only text in a `<pre>`. Dirty state, ⌘S, the mtime check on write and the CodeMirror dependency are all B2, which needs its own plan.

## Global Constraints

- **No em dashes** in any code, comment, commit message or document. Use commas, colons, parentheses or separate sentences.
- **vitest runs `environment: 'node'`.** There is no DOM and no layout in unit tests. React components are covered by Playwright e2e only. Do not add a DOM environment; move logic into a pure module instead. This is why `tabLabel`, `paneGroups` and the new merge module are pure.
- **Every claim written in a comment must be measured, not reasoned.** Where a step says to record an observed result, run it and write down what happened. Do not transcribe this plan's expectation as if it were an observation. Slice A's plan predicted four mutation results and got three of them wrong; the implementers who ran them and wrote down the real numbers were right to.
- **The renderer never supplies an absolute path across IPC.** File reads cross as `(projectId, relPath)` and are resolved against config in main, through the guard `src/main/files/tree.ts` already owns. `PaneRecord.filePath` IS absolute, but it is written by main and only ever read back by main.
- **Testid prefixes.** Existing e2e locators count by `tab-`, `skill-`, `pane-`, `project-`, `close-`, `palette-session-`, `palette-action-`, `swatch-`, `tree-`. This plan adds `editor-`. Verify with `grep -rn 'data-testid\^=' tests/e2e/` before adding one, and note that `pane-` is counted by `splits.spec.ts`, whose comments say `[data-testid^="pane-"]` also matches `pane-divider`.
- **Scroll containers get `scroll-thin`** (`src/renderer/index.css`).
- **The restore path fails silently.** `b397216` added a pane field that was correct on screen, correct on disk, and gone after relaunch with nothing thrown. Task 4 exists because of that, and it lands a relaunch e2e BEFORE any UI can open an editor pane.
- Run `npm run typecheck` and `npm test` before every commit. `npm run e2e` before commits that touch the renderer or restore.

## What this plan does NOT do

Named so they are not added quietly:

- CodeMirror, syntax highlighting, editing, ⌘S, dirty dots, the mtime check. All B2.
- Writing a file. B1 opens `fsRead` and nothing else. There is no write channel.
- Git panes. Slice C, unspecified.
- Reusing one editor tab for successive files. Decided against for B1: each file opens its own tab. Revisit only if the tab bar becomes unusable, and note it needs no store change.

## Decisions taken before this plan was written

- **Two plans, not one.** B1 is the model, the restore path and the skip sites, with a read-only view. B2 is CodeMirror. The restore work is the part this repo has lost a field to before, and it should be reviewable without a 400KB dependency in the same diff.
- **Clicking a file opens a new tab per file.** Not a split into the active tab (which would rearrange a tab you were working in) and not one reused editor tab (which would need replace-semantics and a dirty prompt in the same slice that rewrites restore).
- **The read-only view is real content, not a placeholder.** It makes the relaunch e2e assert that a file's text came back, rather than that a pane shell exists.

---

### Task 1: The store learns a pane with no session

`TabType` gains a fourth member, `tmuxSession` becomes optional, `filePath` appears, and `isPane` stops requiring a session from every row while still requiring one from every terminal row. Pure validation over plain objects, so all of it is unit tested.

**Files:**
- Modify: `src/shared/ipc.ts` (`TabType`, `TabDescriptor`)
- Modify: `src/main/sessions/manager.ts` (`PaneRecord`)
- Modify: `src/main/state/store.ts` (`isPane`, `TAB_TYPES`, `normalisePane`, the migrate branch, the two `version: 7` literals)
- Modify: `tests/unit/store.test.ts` (or whichever unit file already covers `isPane` and the migrate branch; find it with `grep -rln "isPane\|version: 7" tests/`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, relied on by Tasks 3, 4, 5 and 6:
  - `type TabType = 'claude' | 'preset' | 'shell' | 'editor'`
  - `PaneRecord.tmuxSession?: string` and `PaneRecord.filePath?: string`
  - `TabDescriptor.tmuxSession?: string` and `TabDescriptor.filePath?: string`
  - Store version `8`

- [ ] **Step 1: Find the tests that already cover this**

Run: `grep -rln "isPane\|normalisePane\|version: 7" tests/`

Read what is there before adding to it. The existing suite has 1237 tests and the migrate branch is already covered for v5, v6 and v7; you are extending that coverage, not starting it. Add your new cases to the file that already owns this, in its existing style.

- [ ] **Step 2: Write the failing tests**

Add these cases. Match the surrounding file's naming and its `describe` structure.

```typescript
it('accepts a sessionless editor row', () => {
  const config = migrate({
    version: 8,
    projects: [],
    activeProjectId: null,
    panes: [
      { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'editor', filePath: '/tmp/demo/a.ts' },
    ],
    tabs: [],
  })
  expect(config.panes).toHaveLength(1)
  expect(config.panes[0]?.type).toBe('editor')
  expect(config.panes[0]?.filePath).toBe('/tmp/demo/a.ts')
  expect(config.panes[0]?.tmuxSession).toBeUndefined()
})

// The half that must NOT relax. A terminal row with no session is the
// malformed row `isPane` has always rejected, and making `tmuxSession`
// optional on the type is exactly how that rejection gets lost by accident.
it('still rejects a terminal row with no session', () => {
  const config = migrate({
    version: 8,
    projects: [],
    activeProjectId: null,
    panes: [
      { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'shell' },
      { id: 'p2', projectSlug: 'demo', cwd: '/tmp/demo', type: 'claude' },
      { id: 'p3', projectSlug: 'demo', cwd: '/tmp/demo', type: 'preset', command: 'x' },
    ],
    tabs: [],
  })
  expect(config.panes).toEqual([])
})

// A row predating `type` is a terminal row: every version before this one
// only had terminals. So a missing type still requires a session.
it('still rejects a row with no type and no session', () => {
  const config = migrate({
    version: 8,
    projects: [],
    activeProjectId: null,
    panes: [{ id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo' }],
    tabs: [],
  })
  expect(config.panes).toEqual([])
})

// Same reasoning as the colour field: config is a text file, and a
// hand-edited `filePath` of the wrong type must not reach the renderer.
it('drops a filePath that is not a string', () => {
  const config = migrate({
    version: 8,
    projects: [],
    activeProjectId: null,
    panes: [
      { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'editor', filePath: 42 },
    ],
    tabs: [],
  })
  // The row survives, because an editor pane with no file is a pane that
  // says the file is gone (Task 5), not a row worth discarding.
  expect(config.panes).toHaveLength(1)
  expect(config.panes[0]?.filePath).toBeUndefined()
})

it('reads a v7 file as v8 without converting anything', () => {
  const config = migrate({
    version: 7,
    projects: [],
    activeProjectId: null,
    panes: [
      { id: 'p1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'shell', tmuxSession: 'prcli-demo-p1' },
    ],
    tabs: [],
  })
  expect(config.version).toBe(8)
  expect(config.panes[0]?.tmuxSession).toBe('prcli-demo-p1')
  expect(config.panes[0]?.filePath).toBeUndefined()
})
```

If `migrate` is not exported under that name, use whatever the existing tests call. Do not export something new to suit the test.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run <the file you edited>`
Record which cases fail and how. `accepts a sessionless editor row` should fail because `isPane` requires `tmuxSession`; the v7 case should fail on the version number. Write down what you actually saw, including any case that passed already, and say so in your report if the results differ from this prediction.

- [ ] **Step 4: Widen the types**

In `src/shared/ipc.ts`:

```typescript
export type TabType = 'claude' | 'preset' | 'shell' | 'editor'
```

Update that type's existing docstring, which currently says a declaration of intent deciding the launch command: an `editor` pane has no launch command at all. Say so in one clause rather than rewriting the paragraph.

In `TabDescriptor`, make the session optional and add the file:

```typescript
  /**
   * Absent on an editor pane, which has no tmux session at all. Present on
   * every terminal pane, which is what `isPane` still enforces per kind.
   */
  tmuxSession?: string
  /**
   * The file an editor pane is showing, absolute. Absent on every terminal
   * pane, and absent on an editor pane whose file could not be read.
   *
   * Absolute here and relative across `fsRead`: this is written by main and
   * read back by main, and never spelled by the renderer.
   */
  filePath?: string
```

Make the identical two changes to `PaneRecord` in `src/main/sessions/manager.ts`, keeping that file's existing comment style. Note the existing `title` docstring there says nothing in that file reads it; the same is true of `filePath`, and saying so is worth one sentence.

- [ ] **Step 5: Teach the store**

In `src/main/state/store.ts`, `isPane` becomes per-kind:

```typescript
function isPane(value: unknown): value is PaneRecord {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Partial<PaneRecord>
  if (typeof t.id !== 'string') return false
  if (typeof t.projectSlug !== 'string') return false
  if (typeof t.cwd !== 'string') return false
  // Per kind, not per row. An editor pane has no tmux session and never will,
  // so requiring one of every row would drop it. But a TERMINAL row with no
  // session is the malformed row this function has always rejected, and a
  // blanket `typeof t.tmuxSession === 'string' || true` would lose that.
  //
  // A row with no `type` predates the field, and every version before this
  // one held terminals only, so it is a terminal here and needs a session.
  return t.type === 'editor' || typeof t.tmuxSession === 'string'
}
```

Add `'editor'` to `TAB_TYPES`. In `normalisePane`, validate `filePath` beside the colour, for the reason the colour comment already gives:

```typescript
  // Beside the colour above, and for the same reason: config is a text file.
  // A row whose `filePath` is not a string keeps the row and loses the field,
  // which Task 5 draws as a pane saying the file is gone.
  const filed = typeof coloured.filePath === 'string' ? coloured : { ...coloured, filePath: undefined }
```

Then thread `filed` through the rest of that function in place of `coloured`.

Extend the migrate branch to read four versions and write the new one:

```typescript
  // 5, 6, 7 and 8 share a shape. v6 added an optional pane title, v7 an
  // optional pane colour, and v8 an optional file path plus a session that is
  // optional per kind. In every case an older row not having the field is
  // exactly what "never set" already means, so there is nothing to convert and
  // one branch reads all four. A v7 row is a terminal row by construction,
  // because no version before v8 could express a pane without a session.
  if (value.version === 5 || value.version === 6 || value.version === 7 || value.version === 8) {
```

and return `version: 8` from it. Then find every other `version: 7` literal in the repo and update it:

Run: `grep -rn "version: 7" src/ tests/`

`src/main/ipc/restore.ts`'s `store.write` is one of them. Change each, and check the test fixtures that write a config file: an e2e seeding `version: 5` still works through the shared branch, so do not churn fixtures that do not need it.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run <the file you edited>` then `npm test`
Expected: your new cases pass and the existing suite is unbroken. Record the real total.

- [ ] **Step 7: Prove the per-kind guard is load-bearing**

Change `isPane`'s final line to `return true`, and run the unit file again.

Expected: `still rejects a terminal row with no session` and `still rejects a row with no type and no session` fail. Record the OBSERVED count and which tests failed, in the test file's header comment beside any mutation records already there. Restore the line, confirm green, and confirm `git diff src/main/state/store.ts` is empty before committing.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npm test
git add -A
git commit -m "Let a pane exist without a tmux session"
```

---

### Task 2: An editor tab is named for its file

The fourth caller of the one label rule, going through it rather than around it. Pure, one file, unit tested.

**Files:**
- Modify: `src/renderer/lib/tabLabel.ts`
- Modify/Create: `tests/unit/tabLabel.test.ts` (find the existing one first: `grep -rln "tabLabel" tests/`)

**Interfaces:**
- Consumes from Task 1: `TabDescriptor.filePath`, `TabType`'s `'editor'`.
- Produces, relied on by Tasks 5 and 6: `tabLabel` returning a basename for an editor pane.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { tabLabel } from '../../src/renderer/lib/tabLabel'
import type { TabDescriptor } from '../../src/shared/ipc'

const editor = (over: Partial<TabDescriptor> = {}): TabDescriptor =>
  ({
    id: 'abcdef123456',
    projectSlug: 'demo',
    cwd: '/tmp/demo',
    type: 'editor',
    filePath: '/tmp/demo/src/main.ts',
    ...over,
  }) as TabDescriptor

describe('tabLabel, for an editor pane', () => {
  it('names it for the file, not the slug and id', () => {
    expect(tabLabel(editor())).toBe('main.ts')
  })

  // A user-set title still wins, exactly as it does for a terminal. This is
  // the reason the editor case goes through this function rather than being
  // special-cased at each of the four call sites.
  it('still prefers a title the user set', () => {
    expect(tabLabel(editor({ title: 'the parser' }))).toBe('the parser')
  })

  // An editor pane whose file could not be read has no filePath (Task 1
  // drops a malformed one). It must not render as an empty tab.
  it('falls back to the slug and id when there is no file', () => {
    expect(tabLabel(editor({ filePath: undefined }))).toBe('demo · abcdef')
  })

  // A path ending in a separator has no basename. Whatever it does, it must
  // not be blank, because a nameless tab cannot be clicked with confidence.
  it('never returns an empty string', () => {
    expect(tabLabel(editor({ filePath: '/tmp/demo/' }))).not.toBe('')
    expect(tabLabel(editor({ filePath: '/' }))).not.toBe('')
  })
})
```

Keep any existing tests in that file untouched: the terminal cases are the rule this is joining.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/tabLabel.test.ts`
Expected: the editor cases fail, returning `demo · abcdef`. Record what you saw.

- [ ] **Step 3: Implement**

```typescript
export function tabLabel(tab: TabDescriptor): string {
  if (tab.title) return tab.title
  // An editor pane is named for its file, because `slug · id` says nothing
  // about which file you are looking at when several are open at once.
  // `basename` rather than a split: it handles a trailing separator, and a
  // path that yields nothing falls through to the same label a terminal gets
  // rather than to a blank tab.
  if (tab.type === 'editor' && tab.filePath) {
    const name = basename(tab.filePath)
    if (name) return name
  }
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}
```

Import `basename` from `node:path`. **Check this works in the renderer before relying on it**: this file is renderer code, and whether `node:path` resolves there depends on the Vite config and whether `nodeIntegration` is on. Run the e2e suite, not just the unit suite, before you believe it. If it does not resolve, do the basename by hand rather than adding a polyfill, and say in your report that you had to:

```typescript
    const name = tab.filePath.split('/').filter(Boolean).pop() ?? ''
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/unit/tabLabel.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
npm test
git add -A
git commit -m "Name an editor tab for its file"
```

---

### Task 3: Reading one file of one project

The second channel through the guard Slice A built, and the last main-side thing B1 needs. Same shape as `fsList`: a project id and a relative path, resolved in main.

**Files:**
- Modify: `src/main/files/tree.ts` (add `readFileInside`)
- Modify: `src/shared/ipc.ts` (`CHANNELS`, `FileContents`, `PrcliApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/register.ts` (beside the `CHANNELS.fsList` handler)
- Modify: `tests/unit/fileTree.test.ts`
- Modify: `tests/integration/fileTree.test.ts`

**Interfaces:**
- Consumes from Slice A: `resolveInside`, `isInside`, and the `realpath` containment re-check in `src/main/files/tree.ts`. Read that file before writing: it has two halves of a guard and a symlink case that the plan it came from got wrong.
- Produces, relied on by Task 5: `window.prcli.fsRead(projectId, relPath): Promise<FileContents | null>` where `FileContents` is `{ text: string; mtimeMs: number }`.

`mtimeMs` is carried now although nothing in B1 uses it, because B2's mtime check is the reason it exists and adding it later means changing this channel's return type after two tasks depend on it. That is the one piece of B2 this plan admits, deliberately.

- [ ] **Step 1: Write the failing unit tests**

Append to `tests/unit/fileTree.test.ts`, using the fixture that file already builds in its `beforeAll`:

```typescript
describe('readFileInside', () => {
  it('reads a file under the root', async () => {
    const found = await readFileInside(root, 'app.ts')
    expect(found?.text).toBe('')
    expect(typeof found?.mtimeMs).toBe('number')
  })

  it('reads a file in a subdirectory', async () => {
    const found = await readFileInside(root, 'src/nested.ts')
    expect(found?.text).toBe('const x = 1\n')
  })

  // The same boundary `listDir` has, reached through the other entry point.
  // A guard on one channel and not the other is not a guard.
  it('refuses to read outside the root', async () => {
    await expect(readFileInside(root, '../../etc/hosts')).resolves.toBeNull()
    await expect(readFileInside(root, '/etc/hosts')).resolves.toBeNull()
  })

  // The half `..` cannot express, which the listing side already covers.
  it('refuses to read through a symlink pointing outside', async () => {
    await expect(readFileInside(root, 'escape/secret.txt')).resolves.toBeNull()
  })

  it('resolves a missing file to null rather than throwing', async () => {
    await expect(readFileInside(root, 'nope.ts')).resolves.toBeNull()
  })

  // A directory is not a file. Reading one must not throw out of a channel
  // whose caller is a React render.
  it('resolves a directory to null rather than throwing', async () => {
    await expect(readFileInside(root, 'src')).resolves.toBeNull()
  })

  it('refuses a relPath that is not a string', async () => {
    await expect(readFileInside(root, 42 as unknown as string)).resolves.toBeNull()
  })
})
```

Add `src/nested.ts` with the contents `const x = 1\n` to that file's `beforeAll` fixture. **Adding a file to `src/` changes nothing in the existing assertions**, which list the root only, but check that yourself rather than taking this sentence for it: the top-level listing test asserts an exact array.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/fileTree.test.ts`
Expected: FAIL on the missing `readFileInside` import. Record what you saw.

- [ ] **Step 3: Implement it beside the listing**

In `src/main/files/tree.ts`:

```typescript
/** One file's text, with the mtime it had when it was read. */
export interface FileContents {
  text: string
  mtimeMs: number
}

/**
 * One file of one project, or null.
 *
 * The same containment guard `listDir` uses, for the same reason and by the
 * same two halves: `resolveInside` for the path the renderer spelled, and a
 * `realpath` re-check for the one it did not, since `readFile` follows a
 * symlink exactly as `readdir` does.
 *
 * Never throws. A missing file, a directory, an unreadable file and a path
 * that leaves the project are all null: this is called from a React render,
 * and the pane draws "cannot read that" rather than the app failing.
 *
 * The mtime rides along because a later slice refuses to write over a file
 * that changed underneath the pane, and that check needs the mtime the text
 * was read at rather than one fetched separately afterwards.
 */
export async function readFileInside(root: string, relPath: string): Promise<FileContents | null> {
  const target = resolveInside(root, relPath)
  if (target === null) return null
  try {
    const realRoot = await realpath(root)
    const realTarget = await realpath(target)
    if (!isInside(realRoot, realTarget)) return null
    const info = await stat(realTarget)
    if (!info.isFile()) return null
    return { text: await readFile(realTarget, 'utf8'), mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}
```

Add `readFile` and `stat` to the `node:fs/promises` import. `isInside` and the realpath pattern already exist in that file from Slice A; use them rather than re-deriving the comparison, and if the helper is named differently, use the real name.

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: `npx vitest run tests/unit/fileTree.test.ts`
Record the real count.

- [ ] **Step 5: Wire the channel**

In `src/shared/ipc.ts`, add to `CHANNELS`:

```typescript
  fsRead: 'prcli:fsRead',
```

Declare the shape beside `FileEntry`, with the same justification that comment already carries:

```typescript
/**
 * One file's text and the mtime it was read at.
 *
 * Declared here rather than only in `src/main/files/tree.ts` for the reason
 * `FileEntry` gives: the renderer draws this.
 */
export interface FileContents {
  text: string
  mtimeMs: number
}
```

Add to `PrcliApi`, beside `fsList`:

```typescript
  /**
   * One file of one project, or null if it cannot be read.
   *
   * `relPath` is relative to the project's own `cwd` and is resolved against
   * it in main: no absolute path crosses this boundary. A path that would
   * leave the project, a directory, and a missing file all resolve to null
   * rather than rejecting.
   */
  fsRead(projectId: string, relPath: string): Promise<FileContents | null>
```

In `src/preload/index.ts`, beside the `fsList` bridge:

```typescript
  fsRead: (projectId, relPath) => ipcRenderer.invoke(CHANNELS.fsRead, projectId, relPath),
```

In `src/main/ipc/register.ts`, immediately after the `CHANNELS.fsList` handler:

```typescript
  // Beside `fsList` and for the same reasons: outside `serialise` because it
  // reads the filesystem and writes no config, and keyed by project id rather
  // than by a renderer-supplied path.
  ipcMain.handle(CHANNELS.fsRead, async (_event, projectId: string, relPath: string) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return null
    return readFileInside(project.cwd, relPath)
  })
```

Add `readFileInside` to the existing `../files/tree` import.

- [ ] **Step 6: Extend the integration test**

Append to `tests/integration/fileTree.test.ts`, following the local-`handle` pattern that file already uses and its header's honesty about what that does and does not prove:

```typescript
async function handleRead(
  projects: { id: string; cwd: string }[],
  projectId: string,
  relPath: string,
): Promise<{ text: string; mtimeMs: number } | null> {
  const project = projects.find((row) => row.id === projectId)
  if (!project) return null
  return readFileInside(project.cwd, relPath)
}

describe('the fsRead handler', () => {
  it('reads a file from the named project', async () => {
    const found = await handleRead([{ id: 'p1', cwd: root }], 'p1', 'README.md')
    expect(found?.text).toBe('#')
  })

  it('resolves an unknown project to null rather than throwing', async () => {
    await expect(handleRead([{ id: 'p1', cwd: root }], 'nope', 'README.md')).resolves.toBeNull()
  })

  it('will not read outside the project it names', async () => {
    await expect(handleRead([{ id: 'p1', cwd: root }], 'p1', '../../etc/hosts')).resolves.toBeNull()
  })
})
```

- [ ] **Step 7: Prove the guard bites on this channel too**

Change `readFileInside`'s `if (!isInside(realRoot, realTarget)) return null` to `if (false) return null`, and run both test files.

Expected: the symlink case fails. Whether the `../..` and absolute cases also fail depends on `resolveInside`, which is a separate half, so record which ones actually failed rather than assuming all four did. Restore, confirm green, confirm `git diff src/main/files/tree.ts` is empty, and write the observed result into `tests/unit/fileTree.test.ts`'s existing mutation-record header as the next numbered round.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npm test
git add -A
git commit -m "Read one file of one project, through the same guard as the listing"
```

---

### Task 4: A sessionless pane survives a relaunch

The task this plan exists for, and it lands before anything can create an editor pane through the UI, so the relaunch assertion comes first rather than last. `restoreWorkspace` starts from live tmux and can only return panes tmux told it about; sessionless panes are merged back in by a pure module, so the merge is unit tested with no tmux and no Electron.

**Files:**
- Create: `src/main/ipc/sessionlessPanes.ts`
- Create: `tests/unit/sessionlessPanes.test.ts`
- Modify: `src/main/ipc/restore.ts` (the assembly at the end of `restoreWorkspace`)
- Modify: `src/main/ipc/savedFields.ts` (`attachSavedFields`)
- Create: `tests/e2e/editorRestore.spec.ts`

**Interfaces:**
- Consumes from Task 1: `PaneRecord.filePath`, the optional `tmuxSession`, `TabType`'s `'editor'`.
- Produces, relied on by Tasks 5 and 6: an editor pane row in `config.panes` and its tab row in `config.tabs` surviving a relaunch.
  - `export function mergeSessionlessPanes(input: MergeInput): MergeResult`

**Before starting:** read `src/main/ipc/restore.ts` end to end. It is 492 lines, its comments carry the reasoning behind decisions that look arbitrary, and the assembly you are changing sits in the last 60 lines. Read `src/main/ipc/savedFields.ts` too: it is short, and its docstring lists what is deliberately NOT reattached and why.

- [ ] **Step 1: Write the failing unit tests for the merge**

Create `tests/unit/sessionlessPanes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mergeSessionlessPanes } from '../../src/main/ipc/sessionlessPanes'
import type { PaneRecord } from '../../src/main/sessions/manager'

const term = (id: string): PaneRecord => ({
  id,
  projectSlug: 'demo',
  cwd: '/tmp/demo',
  type: 'shell',
  tmuxSession: `prcli-demo-${id}`,
})

const editor = (id: string, filePath = `/tmp/demo/${id}.ts`): PaneRecord => ({
  id,
  projectSlug: 'demo',
  cwd: '/tmp/demo',
  type: 'editor',
  filePath,
})

describe('mergeSessionlessPanes', () => {
  // The whole point. Restore returns what tmux had; an editor pane was never
  // in that answer and would be written away by the config write that follows.
  it('adds a saved editor pane that live restore could not know about', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [{ id: 'tabA', groupId: 'tabA', kids: ['t1'], dir: 'row', ratio: [1] }],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [
        { id: 'tabA', groupId: 'tabA', kids: ['t1'], dir: 'row', ratio: [1] },
        { id: 'tabE', groupId: 'tabE', kids: ['e1'], dir: 'row', ratio: [1] },
      ],
    })
    expect(result.panes.map((pane) => pane.id)).toEqual(['t1', 'e1'])
    expect(result.tabs.map((tab) => tab.id)).toEqual(['tabA', 'tabE'])
    expect(result.panes.find((pane) => pane.id === 'e1')?.filePath).toBe('/tmp/demo/e1.ts')
  })

  // A dead terminal must still be dropped. This function adds sessionless
  // panes back; it is not a licence to resurrect panes tmux said were gone.
  it('does not bring back a terminal pane restore dropped', () => {
    const result = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: [term('t1')],
      savedTabs: [{ id: 'tabA', groupId: 'tabA', kids: ['t1'], dir: 'row', ratio: [1] }],
    })
    expect(result.panes).toEqual([])
    expect(result.tabs).toEqual([])
  })

  // A tab holding one live terminal and one editor: the editor rejoins the
  // tab it was in rather than becoming a tab of its own.
  it('returns an editor pane to a tab that survived', () => {
    const result = mergeSessionlessPanes({
      livePanes: [term('t1')],
      liveTabs: [{ id: 'tabA', groupId: 'tabA', kids: ['t1'], dir: 'row', ratio: [1] }],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [{ id: 'tabA', groupId: 'tabA', kids: ['t1', 'e1'], dir: 'row', ratio: [0.5, 0.5] }],
    })
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.kids).toEqual(['t1', 'e1'])
    expect(result.tabs[0]?.ratio).toEqual([0.5, 0.5])
  })

  // The mixed tab whose terminal died. The editor is still here, so the tab
  // is still here, holding only the editor and summing to 1.
  it('keeps a mixed tab alive on its editor alone when the terminal died', () => {
    const result = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: [term('t1'), editor('e1')],
      savedTabs: [{ id: 'tabA', groupId: 'tabA', kids: ['t1', 'e1'], dir: 'row', ratio: [0.5, 0.5] }],
    })
    expect(result.panes.map((pane) => pane.id)).toEqual(['e1'])
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.kids).toEqual(['e1'])
    expect(result.tabs[0]?.ratio).toEqual([1])
  })

  // An editor row with no tab row at all. It must not appear as a pane no tab
  // holds, which is a pane the user cannot reach or close.
  it('drops an editor pane no saved tab holds', () => {
    const result = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: [editor('e1')],
      savedTabs: [],
    })
    expect(result.panes).toEqual([])
    expect(result.tabs).toEqual([])
  })

  it('is a no-op when nothing saved is sessionless', () => {
    const live = [term('t1')]
    const tabs = [{ id: 'tabA', groupId: 'tabA', kids: ['t1'], dir: 'row' as const, ratio: [1] }]
    const result = mergeSessionlessPanes({
      livePanes: live,
      liveTabs: tabs,
      savedPanes: live,
      savedTabs: tabs,
    })
    expect(result.panes).toEqual(live)
    expect(result.tabs).toEqual(tabs)
  })
})
```

**The `TabRow` shape in these tests is a guess.** Read the real one in `src/main/state/store.ts` or wherever `TabRow` is declared, and fix the fixtures to match it exactly before running. If a row carries fields these fixtures omit, include them. Do not change the real type to match the test.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/sessionlessPanes.test.ts`
Expected: FAIL on the missing import. Record it.

- [ ] **Step 3: Write the merge module**

Create `src/main/ipc/sessionlessPanes.ts`. The shape below is the contract; write the body to satisfy the tests above.

```typescript
import type { PaneRecord } from '../sessions/manager'
import type { TabRow } from '../state/store'

export interface MergeInput {
  /** What live tmux gave back, already attached. */
  livePanes: PaneRecord[]
  /** The tab rows built from those live panes. */
  liveTabs: TabRow[]
  /** Every pane row on disk, including the ones tmux knows nothing about. */
  savedPanes: PaneRecord[]
  /** Every tab row on disk. */
  savedTabs: TabRow[]
}

export interface MergeResult {
  panes: PaneRecord[]
  tabs: TabRow[]
}

/**
 * Live restore's answer, plus the panes it could not have known about.
 *
 * `restoreWorkspace` starts from tmux: it asks what sessions exist, attaches
 * them, and builds one tab row per live group. That is the right shape for a
 * terminal and the wrong shape for a pane that never had a session, which
 * would be absent from the reply and then written away by the config write
 * that follows it.
 *
 * So this is additive and narrow. It puts back exactly the saved panes whose
 * kind has no session, and it never resurrects a terminal: a saved terminal
 * row missing from `livePanes` is a session tmux says is gone, which is the
 * judgement this function must not second-guess.
 *
 * A sessionless pane rejoins the tab its saved row named. If that tab also
 * came back live, the pane is inserted in the saved kid order; if every other
 * pane in it died, the tab survives on its sessionless panes alone, because
 * an editor cannot die and a tab holding one is not empty. A sessionless pane
 * whose tab row is gone is dropped: a pane no tab holds cannot be reached,
 * focused, or closed.
 *
 * Ratios are renormalised to sum to 1 whenever the kid list changes, for the
 * reason `sharesAroundClaims` gives: survivors summing to less than 1 leave a
 * gap no pane owns.
 */
export function mergeSessionlessPanes(input: MergeInput): MergeResult {
  const { livePanes, liveTabs, savedPanes, savedTabs } = input

  // By kind, never by "has no session". A terminal row missing its session was
  // already rejected by `isPane`, and treating absence as sessionlessness here
  // would put exactly those malformed rows back.
  const sessionless = savedPanes.filter((pane) => pane.type === 'editor')
  if (sessionless.length === 0) return { panes: livePanes, tabs: liveTabs }

  const liveIds = new Set(livePanes.map((pane) => pane.id))
  const survivors = new Map<string, PaneRecord>()
  for (const pane of sessionless) {
    // A pane already in the live answer needs nothing: it cannot be there,
    // but if a future kind is both sessionless and attachable, this keeps the
    // function from listing it twice.
    if (!liveIds.has(pane.id)) survivors.set(pane.id, pane)
  }

  const liveById = new Map(liveTabs.map((tab) => [tab.id, tab]))
  const tabs: TabRow[] = []
  const placed = new Set<string>()

  // Saved order, so a tab's position on screen does not depend on whether its
  // panes happened to be live ones.
  for (const saved of savedTabs) {
    const live = liveById.get(saved.id)
    // Every kid that is still real: a live pane, or a sessionless one that
    // cannot have died. A saved terminal absent from `livePanes` is a session
    // tmux says is gone, and this function does not second-guess that.
    const kids = saved.kids.filter((id) => liveIds.has(id) || survivors.has(id))
    if (kids.length === 0) continue

    for (const id of kids) if (survivors.has(id)) placed.add(id)

    // Untouched when the live row already holds exactly these kids: the live
    // row carries whatever restore resolved for it, and rebuilding it from the
    // saved row would put a stale axis or stale ratios back over that.
    if (live && live.kids.length === kids.length && live.kids.every((id, at) => id === kids[at])) {
      tabs.push(live)
      continue
    }

    const source = live ?? saved
    tabs.push({ ...source, kids, ratio: evenRatio(kids.length) })
  }

  // A live tab with no saved row at all: a tab founded this session. Kept as
  // it is, and appended, since no saved order can place it.
  for (const tab of liveTabs) {
    if (!savedTabs.some((saved) => saved.id === tab.id)) tabs.push(tab)
  }

  // Only the sessionless panes a tab actually holds. One no tab holds cannot
  // be reached, focused or closed, so it is dropped rather than orphaned.
  const panes = [...livePanes, ...sessionless.filter((pane) => placed.has(pane.id))]
  return { panes, tabs }
}

/**
 * Equal shares for `count` panes, summing to 1.
 *
 * Renormalised rather than carried whenever the kid list changes, for the
 * reason `sharesAroundClaims` gives: survivors summing to less than 1 leave a
 * gap that no pane owns and nothing redraws.
 */
function evenRatio(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}
```

Two things to check against the real code before trusting the above. First, `TabRow`'s actual field names: this uses `id`, `groupId`, `kids`, `dir` and `ratio`, and if the real row differs, follow the real one. Second, whether preserving a saved tab's original ratios matters more than the even split used here when only some kids survive: `evenRatio` is the conservative choice because it cannot desynchronise the two arrays, but if the codebase already has a renormaliser, use that instead of adding a second one.

Two rules to get right, both of which have a test above:

1. Sessionless is decided by kind, not by the absence of a session. Use `pane.type === 'editor'`. A terminal row that somehow lacks a session was already rejected by `isPane` in Task 1, and treating "no session" as "sessionless" here would resurrect exactly the malformed rows that guard exists to drop.
2. Renormalise `ratio` whenever `kids` changes length, and keep the two arrays the same length. A tab row whose `ratio` does not match its `kids` is the class of bug `sharesAroundClaims` exists to prevent.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/unit/sessionlessPanes.test.ts`
Record the real count.

- [ ] **Step 5: Call it from restore**

In `src/main/ipc/restore.ts`, at the assembly near the end of `restoreWorkspace`, the current code computes `tabRows` from `held`, then `const restored = attachSavedFields(panes, saved.panes)`, then writes. Insert the merge between the tab rows and `attachSavedFields`:

```typescript
    // Live tmux is the whole of what `panes` and `tabRows` know, and a pane
    // with no session was never in that answer. Merged in here, before
    // `attachSavedFields` and before the write, because the write below is
    // what would otherwise persist their absence: correct on screen, correct
    // on disk until relaunch, then gone, with nothing thrown. That is exactly
    // how `b397216` lost a pane's colour.
    const merged = mergeSessionlessPanes({
      livePanes: panes,
      liveTabs: tabRows,
      savedPanes: saved.panes,
      savedTabs: saved.tabs,
    })

    const restored = attachSavedFields(merged.panes, saved.panes)
```

Then use `merged.tabs` in place of `tabRows` in BOTH the `store.write` call and the returned object. Read the comment already above the return: it says `tabs` rides along rather than being re-read, and the same reasoning applies to what you are substituting.

- [ ] **Step 6: Teach `attachSavedFields` the new field**

In `src/main/ipc/savedFields.ts`, beside `title` and `color`:

```typescript
    if (row.filePath) next.filePath = row.filePath
```

Update that function's docstring, which explains that fields are carried one by one rather than by spreading the saved row. `filePath` belongs to the same category as `title` and `color`: config persists it, tmux knows nothing about it. This one line is the difference between an editor tab that reopens with its file and one that reopens blank, and nothing throws either way.

- [ ] **Step 7: Write the relaunch e2e**

Create `tests/e2e/editorRestore.spec.ts`. It seeds an editor pane directly into `config.json` and relaunches, because no UI can create one until Task 5.

```typescript
/**
 * A pane with no tmux session, across a relaunch.
 *
 * This file exists because the restore path fails silently: `b397216` added a
 * pane field that was correct on screen, correct on disk, and gone after
 * relaunch, with nothing thrown. Every assertion here is about what came back
 * from disk, and the pane is seeded into config rather than created through
 * the UI, so this runs before any UI can make one.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-editor-restore'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string

const relaunch = async (): Promise<void> => {
  await app.close()
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-ed-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-ed-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-ed-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-ed-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-ed-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  await writeFile(join(projectCwd, 'src', 'seeded.ts'), 'const seeded = 1\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 8,
      // `slug` is required: `isProject` drops a project row without one,
      // silently, and there is then no project for the pane to belong to.
      projects: [{ id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [] }],
      panes: [
        {
          id: 'e1',
          projectSlug: 'demo',
          cwd: projectCwd,
          type: 'editor',
          filePath: join(projectCwd, 'src', 'seeded.ts'),
        },
      ],
      tabs: [{ id: 'tabE', groupId: 'tabE', kids: ['e1'], dir: 'row', ratio: [1] }],
      activeProjectId: 'p1',
      activeTabId: 'tabE',
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

test('a seeded editor pane is on screen at launch', async () => {
  await expect(page.getByTestId('pane-e1')).toBeVisible({ timeout: 10_000 })
})

// The assertion this file exists for. Not "a pane is there" but "the pane and
// its file path are still in the file restore just wrote".
test('restore does not write the editor pane away', async () => {
  await expect(page.getByTestId('pane-e1')).toBeVisible({ timeout: 10_000 })
  const written = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  const pane = written.panes.find((row: { id: string }) => row.id === 'e1')
  expect(pane).toBeDefined()
  expect(pane.filePath).toBe(join(projectCwd, 'src', 'seeded.ts'))
  expect(written.tabs.some((row: { id: string }) => row.id === 'tabE')).toBe(true)
})

test('the editor pane comes back after a relaunch', async () => {
  await relaunch()
  await expect(page.getByTestId('pane-e1')).toBeVisible({ timeout: 10_000 })

  const written = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  const pane = written.panes.find((row: { id: string }) => row.id === 'e1')
  expect(pane?.filePath).toBe(join(projectCwd, 'src', 'seeded.ts'))
})
```

**Check `launchApp`'s real signature in `tests/e2e/harness.ts`** before running this, and check whether any existing spec relaunches an app so you can follow its pattern rather than inventing `relaunch`. If none does, say so in your report: this would be the first, and it is the pattern B2 will need too.

`pane-e1` uses the `pane-` prefix that `splits.spec.ts` counts. That is correct and unavoidable, since an editor pane IS a pane, but this file seeds its own config directory so it cannot affect another spec's counts. Confirm that reasoning holds by running the full suite, not just this file.

- [ ] **Step 8: Run it and watch the right things fail**

Run: `npm run e2e -- tests/e2e/editorRestore.spec.ts`

Record what actually happened per test. If the first test fails, the pane is not rendering at all, which is Task 5's job, not this task's: in that case, assert on the config file only for now and note in your report that the visual assertions are deferred to Task 5, rather than deleting them. **Do not weaken the config assertions to get green.**

- [ ] **Step 9: Prove the merge is load-bearing**

Delete the `mergeSessionlessPanes` call from `restore.ts`, restoring `attachSavedFields(panes, saved.panes)` and the original `tabRows`, then run this spec file.

Expected: `restore does not write the editor pane away` and `the editor pane comes back after a relaunch` both fail. Record the OBSERVED result and which assertion each failed at, in this spec file's header. Restore the call, confirm green, and confirm `git diff src/main/ipc/restore.ts` is empty.

Then do the same for the one line in `savedFields.ts`: delete `if (row.filePath) next.filePath = row.filePath` and run again. Record what fails. If NOTHING fails, that is the finding, not a formality: it means `filePath` is surviving by some other route and the line is not what is carrying it. Say so plainly in your report rather than moving on.

- [ ] **Step 10: Full verification and commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Restore a pane that never had a session"
```

---

### Task 5: Clicking a file opens it

The first task with anything on screen. A file row in the tree opens a new tab holding one editor pane, and that pane renders the file read-only.

**Files:**
- Create: `src/renderer/FileView.tsx`
- Modify: `src/renderer/FileTree.tsx` (an `onOpenFile` prop, called from the row click)
- Modify: `src/renderer/Sidebar.tsx` (pass it through)
- Modify: `src/renderer/App.tsx` (the handler that creates the tab, and the pane render branch)
- Modify: `src/main/ipc/register.ts` (a channel that creates an editor pane row)
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts` (that channel)
- Create: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes from Task 1: `TabType`'s `'editor'`, `PaneRecord.filePath`.
- Consumes from Task 2: `tabLabel` naming an editor tab for its file.
- Consumes from Task 3: `window.prcli.fsRead(projectId, relPath)`.
- Produces, relied on by Task 6: an editor pane on screen, testid `pane-<id>`, containing `editor-content` or `editor-missing`.

**Before starting:** read `src/renderer/App.tsx` around the pane render (search for `data-testid={\`pane-`), and around the `newTab` case in its command handling. The pane render currently mounts `<Terminal>` unconditionally for every pane; that is the branch you are adding to. Read `src/renderer/FileTree.tsx` in full, which is short.

- [ ] **Step 1: Write the failing e2e**

Create `tests/e2e/editor.spec.ts`, seeding its own project directory the way `tests/e2e/filetree.spec.ts` does. Copy that file's `beforeAll`/`afterAll` shape, with `SOCKET = 'prcli-e2e-editor'` and its own temp dirs, seeding:

```
demo/src/app.ts       containing: export const answer = 42
demo/README.md        containing: # demo
```

```typescript
test('clicking a file opens a tab named for it', async () => {
  await page.getByTestId('tree-row-README.md').click()

  // Named for the file, through the one label rule rather than around it.
  await expect(page.getByText('README.md', { exact: true })).toBeVisible({ timeout: 10_000 })
})

test('the pane shows the file contents', async () => {
  await expect(page.getByTestId('editor-content')).toContainText('# demo')
})

// A second file gets a second tab, which is this slice's ruling: one tab per
// file, rather than one editor tab that swaps its contents.
test('a second file opens a second tab', async () => {
  const before = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('tree-row-src').click()
  await page.getByTestId('tree-row-src/app.ts').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(before + 1)
  await expect(page.getByTestId('editor-content')).toContainText('export const answer = 42')
})

// A file that is gone must say so rather than vanishing, so a moved file is
// visible rather than mysterious.
test('a file that cannot be read says so', async () => {
  await rm(join(projectCwd, 'src', 'app.ts'))
  await page.getByTestId('tree-refresh').click()
  // The tab is still open on the deleted file. Reopening it is what re-reads.
  await page.reload()
  await expect(page.getByTestId('editor-missing')).toBeVisible({ timeout: 10_000 })
})
```

**The last test's mechanism is a guess and you must verify it.** `page.reload()` re-runs the renderer, which re-reads each editor pane's file; if the app does not re-read on reload, find what does and use that instead, and say in your report what you changed and why. Do not weaken the assertion to whatever passes.

Note `[data-testid^="tab-"]` is the prefix 27 locators use to count tabs. Counting relative to `before` rather than to a literal is deliberate.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run e2e -- tests/e2e/editor.spec.ts`
Expected: FAIL, the first test timing out because clicking a file row does nothing. Record it.

- [ ] **Step 3: The channel that creates an editor pane**

The renderer cannot write config, and a pane row is config. Add a channel alongside the others in `src/main/ipc/register.ts`, INSIDE `serialise` because it writes config, unlike `fsList` and `fsRead`:

```typescript
  // Inside `serialise`, unlike `fsList` and `fsRead` beside it: this one
  // writes a pane row and a tab row, and two of them racing would interleave
  // two read-modify-write cycles over one config file.
  ipcMain.handle(CHANNELS.openEditor, async (_event, projectId: string, relPath: string) => {
    // ...
  })
```

It must: look the project up by id, resolve `relPath` against the project's `cwd` through the SAME guard `fsRead` uses (do not re-derive the containment check, and do not accept an absolute path from the renderer), return null if that resolves to nothing, then create a pane row with a fresh id, `type: 'editor'`, the absolute `filePath`, no `tmuxSession`, and a tab row holding it, write both, and return the new `TabDescriptor` and tab id so the renderer can select it.

Follow the existing pane-creating handlers for how ids are minted, how a tab row is added (`withTabRow` is named in `restore.ts`'s comments), and how the reply is shaped. Read one before writing this.

Declare `CHANNELS.openEditor` and its `PrcliApi` entry in `src/shared/ipc.ts` and bridge it in `src/preload/index.ts`, following `fsRead` from Task 3.

- [ ] **Step 4: The view**

Create `src/renderer/FileView.tsx`:

```typescript
import { useEffect, useState } from 'react'

/**
 * One file, read-only.
 *
 * A `<pre>` rather than an editor: CodeMirror is slice B2, and this slice is
 * the pane model and the restore path. What is here has to be real content
 * rather than a placeholder, because the relaunch test's whole value is
 * asserting a file's text came back.
 *
 * The read happens here rather than in `App.tsx` so a pane fetches its own
 * file when it mounts, including after a relaunch, where nothing else knows
 * to go and get it.
 */
export function FileView({ projectId, relPath }: { projectId: string; relPath: string }) {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let live = true
    window.prcli
      .fsRead(projectId, relPath)
      .then((found) => {
        if (!live) return
        if (found === null) setMissing(true)
        else setText(found.text)
      })
      // Swallowed like the tree's own fetch: a file that will not read is a
      // pane that says so, and this is not where transport faults get
      // reported.
      .catch(() => {
        if (live) setMissing(true)
      })
    return () => {
      live = false
    }
  }, [projectId, relPath])

  if (missing) {
    return (
      <div data-testid="editor-missing" className="p-3 font-mono text-[11px] text-faint">
        That file is no longer there.
      </div>
    )
  }

  return (
    <pre
      data-testid="editor-content"
      className="scroll-thin h-full overflow-auto p-3 font-mono text-[11px] leading-relaxed"
    >
      {text ?? ''}
    </pre>
  )
}
```

The `live` flag is the same guard `FileTree` needed after its review: a fetch resolving after the pane changed file must not write into the new one.

`FileView` takes a project id and a RELATIVE path, because that is what `fsRead` takes. The pane row stores an absolute `filePath`, so `App.tsx` converts one to the other when it renders. Do that conversion in a pure helper in `src/renderer/lib/`, with unit tests, rather than inline in the component: vitest cannot see a component, and a path calculation that only e2e can reach is exactly what this codebase keeps getting bitten by. One function, something like `relativeToProject(cwd: string, filePath: string): string | null`, with cases for a file inside the project, a file outside it, and an exact match.

- [ ] **Step 5: Render it**

In `src/renderer/App.tsx`'s pane render, branch instead of always mounting `<Terminal>`:

```typescript
                    {box.pane.type === 'editor' ? (
                      <FileView projectId={...} relPath={...} />
                    ) : (
                      <Terminal
                        tabId={box.pane.id}
                        color={box.pane.color ?? PANE_COLOR_DEFAULT}
                        visible={group.visible}
                        focused={group.visible && box.pane.id === activePaneId}
                      />
                    )}
```

Keep the existing `<Terminal>` props exactly as they are. Fill the two `FileView` props from the pane's project and its `filePath`, via the helper from Step 4; a pane whose path does not resolve renders the missing state.

- [ ] **Step 6: Wire the click**

Give `FileTree` an `onOpenFile` prop and call it from `toggle` when the row is not a directory, where that function currently returns early. Pass it down from `Sidebar.tsx`, and implement it in `App.tsx` by calling the new channel and then selecting the tab it returns, following whatever the `newTab` path already does to select a freshly made tab.

Clicking a directory must still only expand it, and must not open anything.

- [ ] **Step 7: Run the e2e and watch it pass**

Run: `npm run e2e -- tests/e2e/editor.spec.ts`
Record the real result per test.

- [ ] **Step 8: Prove the click is what opens it**

Change `FileTree`'s row click so it returns before calling `onOpenFile` for a file, and run the spec file.

Expected: every test in it fails. Record the observed result in the spec's header. Restore, confirm green, confirm an empty `git diff`.

- [ ] **Step 9: Full verification and commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Open a file from the tree into a pane of its own"
```

Run the FULL e2e suite here, not just your file. This task changes the pane render that every existing spec exercises, and `splits.spec.ts` encodes the sidebar and pane geometry in pixel constants.

---

### Task 6: Everything that assumes a pane has a session

Seven behaviours, each a silent wrong answer rather than a crash. Enumerated by the spec because that is how they were found.

**Files:**
- Modify: `src/renderer/workspace.ts` (`paneGroups`'s dead decision, and `needsYou` if it needs it)
- Modify: `src/renderer/App.tsx` (close, ⌘D, the pane menu's restart entry)
- Modify: `src/renderer/TabBar.tsx` and/or `src/renderer/StatusDot.tsx`
- Modify: `tests/unit/workspace.test.ts` (find the real name with `grep -rln "paneGroups" tests/`)
- Modify: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes from Task 5: an editor pane on screen.
- Produces: nothing later depends on.

**Check each premise before changing anything.** Some of these may already be correct: `needsYou` filters on `state.status[pane.id]` being `waiting` or `crashed`, and an editor pane has no status, so it may already be excluded. A test that pins existing correct behaviour is worth writing; a change to code that was already right is not. For each of the seven, first write the test, then run it, and only write code if the test fails. Report which ones already passed.

- [ ] **Step 1: Write the unit tests for the pure ones**

Three of the seven are decided in pure code and belong in unit tests:

```typescript
// An editor cannot die, so the overlay must never mount on one. `paneGroups`
// decides this once, down both its branches, which is why it is tested here
// rather than through the DOM.
it('never marks an editor pane dead', () => {
  const groups = paneGroups({
    // ... a state holding one editor pane whose status is absent, and one
    // whose status is somehow 'crashed', which config or a stale event could
    // produce. Neither is dead.
  })
  expect(groups.flatMap((group) => group.panes).every((box) => !box.dead)).toBe(true)
})

it('does not count an editor pane as needing you', () => {
  expect(needsYou({ /* an editor pane with status 'waiting' */ })).toEqual([])
})
```

Match the real signatures of `paneGroups` and `needsYou` by reading them and the tests that already cover them. The state fixtures those tests already build are what to extend.

- [ ] **Step 2: Run them and record which already pass**

Run: `npx vitest run <the workspace test file>`
Record, per test, whether it passed before you changed anything. This is the point of the step: an already-correct behaviour gets a test and no code change.

- [ ] **Step 3: Fix the ones that failed**

Only those. For `paneGroups`, gate the dead decision on the pane's kind:

```typescript
  // An editor pane has no session to lose, so nothing can make it dead. A
  // `status` of `crashed` on one is stale config or a misrouted event, and
  // drawing the restart overlay on it would offer a restart of nothing.
```

- [ ] **Step 4: The four behavioural ones, in e2e**

Append to `tests/e2e/editor.spec.ts`. Each needs the file's existing shared `page` and its ordering conventions.

```typescript
test('an editor pane draws no status dot', async () => {
  // Assert on the editor tab specifically, not on "no dots anywhere": other
  // tabs in this workspace legitimately have them.
})

test('closing an editor pane kills no session and writes no tombstone', async () => {
  // Close it, then assert the pane is gone from config and that no tombstone
  // row was written. Read config.json directly, the way editorRestore.spec.ts
  // does: a tombstone is a disk fact, and asserting on screen would not see it.
})

test('the pane menu offers no restart on an editor', async () => {
  // Right-click opens the colour menu (App.tsx's onContextMenu). Assert the
  // restart entry is absent for an editor pane and present for a terminal.
})

test('⌘D splits an editor pane like any other', async () => {
  // Allowed, per the spec. Assert the pane count in the tab goes up.
})
```

Fill each body against the real markup. Where an assertion needs a testid that does not exist, add one under the `editor-` prefix rather than reaching for a class selector, and check the prefix table in Global Constraints first.

For the tombstone test, find how tombstones are written and named (`forgetTab` is referenced in `savedFields.ts`'s docstring) and assert on the real shape rather than a guessed one.

- [ ] **Step 5: Run, fix, and record**

Run: `npm run e2e -- tests/e2e/editor.spec.ts`

For each of the four, record whether it passed before you changed code. Fix only what failed.

- [ ] **Step 6: Prove two of them bite**

Pick the two whose implementation you actually changed, and mutate each in turn: re-allow the dead overlay on an editor, and re-offer restart on one. Run the covering test each time and record which assertion failed. If a behaviour needed no code change, there is nothing to mutate and you should say so rather than inventing a mutation.

Restore both, confirm green, confirm an empty `git diff` on the source files.

- [ ] **Step 7: Full verification and commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Teach the app that a pane can have nothing to restart"
```

---

## Risks carried into execution

1. **The restore path.** Task 4 is the one that matters and it lands before any UI exists to create an editor pane, deliberately. Every mutation step in it is about proving a silent failure would be caught.
2. **A parallel session works in this region.** Slice A's plan had stale line references for `Sidebar.tsx` and `App.tsx` within a day. Run `git log --oneline -5` and re-read any file before editing it; do not trust this document's line numbers.
3. **`splits.spec.ts` encodes the pane row's geometry in pixel constants**, and `[data-testid^="pane-"]` counts every pane including dividers. Tasks 5 and 6 add a pane kind to that row. Run the full e2e suite on those tasks, not just the new spec.
4. **This plan's own predictions are not measurements.** Slice A's plan predicted four mutation outcomes and three were wrong: one mutation could not fail at all, and another passed because an earlier test had cleared a cache. Where a step says "Expected", treat it as a hypothesis to test, and write down what actually happened.
