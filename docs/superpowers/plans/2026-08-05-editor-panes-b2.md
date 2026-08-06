# Editor Panes (Slice B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor pane you can actually edit: CodeMirror instead of a `<pre>`, a dot in the tab when it is dirty, ⌘S to save, and a write that refuses if the file changed underneath you.

**Architecture:** A `fsWrite` channel lands first, main-side and testable with no UI, refusing on an mtime mismatch and answering with a discriminated result rather than throwing. Then CodeMirror replaces the `<pre>` inside the same `FileView` boundary B1 built, so nothing outside that component learns what an editor is. Dirty state lives in `App.tsx` as one map keyed by pane id, because the tab bar draws the dot and the close path has to ask about it, and neither can reach inside the pane.

**Tech Stack:** TypeScript, Electron IPC, React, CodeMirror 6, Tailwind v4, vitest (node environment), Playwright (`_electron.launch`).

This plan is slice **B2** of `docs/superpowers/specs/2026-08-04-file-tree-and-editor-design.md`. Slice B1 (sessionless panes, a read-only pane, the restore path) is merged at `db991a0`.

## Global Constraints

- **No em dashes** in any code, comment, commit message or document. Use commas, colons, parentheses or separate sentences. The surrounding code is full of them, so this is a rule to check the DIFF against, not one the file's style will enforce. `git diff | grep '^+' | grep -c '—'` must be 0.
- **vitest runs `environment: 'node'`.** There is no DOM and no layout in unit tests, and **CodeMirror cannot be unit tested in this repo at all**: it needs a document, a window and a layout. React components are covered by Playwright e2e only. Do not add a DOM environment. Move logic into pure modules under `src/renderer/lib/` instead, which is why `languageForPath` and `dirtyAfterSave` exist as separate files.
- **Every claim written in a comment must be measured, not reasoned.** Where a step says to record an observed result, run it and write down what happened. Do not transcribe this plan's expectation as if it were an observation. B1's plan predicted nine things that turned out false, including two test fixtures that would have passed with the rule under test deleted.
- **The renderer never supplies an absolute path across IPC.** Writes cross as `(projectId, relPath, text, expectedMtimeMs)` and are resolved against config in main, through the guard `src/main/files/tree.ts` owns. `PaneRecord.filePath` IS absolute, but main writes it and only main reads it back.
- **Never autosave.** NOTES autosaves because it is a scratchpad nothing else reads. A source file in a repo Claude is also editing is the opposite case. There is no debounce, no save-on-blur, no save-on-close. `createNoteSaver` is the pattern NOT to copy here.
- **`check-deps` requires every dependency to be imported under `src/`.** A partially wired CodeMirror fails that gate rather than sitting dormant, so each package added in Task 2 must be imported by the end of Task 2's commit.
- **Testid prefixes.** Existing e2e locators count by `tab-`, `skill-`, `pane-`, `project-`, `close-`, `palette-session-`, `palette-action-`, `swatch-`, `tree-`, `editor-`. This plan adds no new prefix: everything here is `editor-`. Verify with `grep -rn 'data-testid\^=' tests/e2e/` before adding one.
- **Scroll containers get `scroll-thin`** (`src/renderer/index.css`).
- **A coloured editor pane and a coloured terminal pane must not disagree.** `PANE_COLORS` is a closed set chosen so `#d4d4d8` stays legible on every entry (the lightest, `#38383d`, leaves 7.89:1). CodeMirror's theme must READ the pane's colour the way `Terminal.tsx:66` does, not hardcode one.
- Run `npm run typecheck` and `npm test` before every commit. `npm run e2e` before commits that touch the renderer.

## What this plan does NOT do

Named so they are not added quietly:

- **Autosave, in any form.** See above.
- **Creating a file, renaming one, or deleting one.** B2 writes over a file that already exists and nothing else.
- **Reload-from-disk as an automatic behaviour.** Reload is manual, for the same reason the tree's refresh is. Task 4 adds a reload only as the way out of a refused save.
- **A file watcher.** The mtime is checked at write time, not polled.
- **Language packs beyond JavaScript/TypeScript and Markdown.** Two packs justify the extension-to-language helper; a third is a one-line addition later and does not need a plan.
- **⌘D on an editor pane.** Deferred out of B1 deliberately and still deferred: it means adding a terminal pane to a tab with no tmux group, plus relaxing `SplitRequest`'s cols/rows guard. `tests/e2e/editor.spec.ts` pins the dead key today and names the route. It wants its own plan.
- Git panes. Slice C, unspecified.

## Decisions taken before this plan was written

- **The CodeMirror footprint was measured before the dependency was committed**, which the spec asked for and which corrected it in both directions. Installed: **4.7M** across 18 packages including `@lezer/*`, not the "roughly 400KB" the spec estimated. Bundled and minified: **297KB** for the five core packages, **521KB** with the two language packs. The spec's conclusion that it is "the largest dependency this app has taken" is false: `@xterm` is 6.0M installed and `react-dom` is 7.1M. It is a real one-way door and it is smaller than the terminal library the app already ships.
- **Dirty state is renderer-only and is never persisted.** A pane that was dirty when the app closed reopens showing what is on disk, because what is on disk is the only thing that survived. The store learns nothing in this slice: no migration, no version bump.
- **The write refuses rather than merging.** With Claude sessions editing the same tree, a changed file is the normal case, not the exotic one. The user is told and offered a reload; nothing is auto-merged and nothing is silently overwritten.

---

### Task 1: Writing one file of one project, and refusing when it moved

The mirror of B1's `readFileInside`, through the same two-half guard, plus the mtime check that is the whole reason B1's `fsRead` returns an mtime nothing reads yet. Main-side only, no UI, so all of it is unit and integration tested.

**Files:**
- Modify: `src/main/files/tree.ts` (add `WriteResult` and `writeFileInside`)
- Modify: `src/shared/ipc.ts` (`CHANNELS`, `WriteResult`, `PrcliApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/register.ts` (beside the `CHANNELS.fsRead` handler)
- Modify: `tests/unit/fileTree.test.ts`
- Modify: `tests/integration/fileTree.test.ts`

**Interfaces:**
- Consumes from B1: `resolveInside`, `isInside`, the `realpath` re-check, and `readFileInside`'s shape. Read that file before writing: its guard has two halves and the plan it came from shipped without the second one, which let a symlink escape the project.
- Produces, relied on by Tasks 4 and 5:
  - `type WriteResult = { ok: true; mtimeMs: number } | { ok: false; reason: 'changed' | 'missing' | 'failed' }`
  - `window.prcli.fsWrite(projectId, relPath, text, expectedMtimeMs): Promise<WriteResult>`

- [ ] **Step 1: Read the guard you are joining**

Run: `grep -n "resolveInside\|isInside\|realpath" src/main/files/tree.ts`

Read `readFileInside` end to end (it is about fifteen lines) and the comment above it. Your function is its mirror and must make the same two checks in the same order, for the same reason: `writeFile` follows a symlink exactly as `readFile` does.

- [ ] **Step 2: Write the failing unit tests**

Append to `tests/unit/fileTree.test.ts`, using the fixture that file already builds in its `beforeAll`. Note it already contains `app.ts` (empty) and `src/nested.ts` (`const x = 1\n`), and an `escape` symlink pointing outside the root.

```typescript
describe('writeFileInside', () => {
  it('writes a file under the root and answers with its new mtime', async () => {
    const before = await readFileInside(root, 'app.ts')
    const result = await writeFileInside(root, 'app.ts', 'changed\n', before!.mtimeMs)
    expect(result.ok).toBe(true)
    const after = await readFileInside(root, 'app.ts')
    expect(after?.text).toBe('changed\n')
    if (result.ok) expect(result.mtimeMs).toBe(after?.mtimeMs)
  })

  // The reason `fsRead` carries an mtime at all. A file that moved under the
  // pane is the normal case here, not the exotic one: Claude is editing the
  // same tree.
  it('refuses when the file changed since it was read', async () => {
    const before = await readFileInside(root, 'src/nested.ts')
    const result = await writeFileInside(root, 'src/nested.ts', 'mine\n', before!.mtimeMs - 1000)
    expect(result).toEqual({ ok: false, reason: 'changed' })
    // And it did not write. A refusal that still wrote is worse than no check.
    const after = await readFileInside(root, 'src/nested.ts')
    expect(after?.text).toBe('const x = 1\n')
  })

  // The same boundary `readFileInside` has, reached through the other verb.
  // A guard on the read and not the write is not a guard.
  it('refuses to write outside the root', async () => {
    const attempts = ['../../tmp/escaped.txt', '/tmp/escaped.txt']
    for (const relPath of attempts) {
      expect(await writeFileInside(root, relPath, 'x', 0)).toEqual({ ok: false, reason: 'failed' })
    }
  })

  // The half `..` cannot express, which the listing and the read both cover.
  it('refuses to write through a symlink pointing outside', async () => {
    const result = await writeFileInside(root, 'escape/secret.txt', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })

  // B2 writes over a file that exists and does nothing else. A file that is
  // gone is a distinct answer from one that changed, because Task 4 draws
  // them differently: one offers a reload, the other cannot.
  it('answers missing for a file that is no longer there', async () => {
    const result = await writeFileInside(root, 'nope.ts', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('refuses a directory rather than throwing', async () => {
    const result = await writeFileInside(root, 'src', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })

  it('refuses a relPath that is not a string', async () => {
    const result = await writeFileInside(root, 42 as unknown as string, 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })
})
```

**Restore the fixture between tests if the first case's write leaks into a later assertion.** The existing `beforeAll` builds the tree once; check whether that file uses `beforeEach` anywhere and follow what is there. If `app.ts`'s new contents break an existing listing assertion, that is a finding to report, not a fixture to quietly adjust.

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run tests/unit/fileTree.test.ts`
Expected: FAIL on the missing `writeFileInside` import. Record what you actually saw, including the count.

- [ ] **Step 4: Implement it beside the read**

In `src/main/files/tree.ts`:

```typescript
/**
 * What a write did, as data rather than as an exception.
 *
 * A refusal is an ordinary answer here: the caller is a React key handler and
 * "the file moved under you" is the case this whole channel exists to catch,
 * not an error condition. `changed` and `missing` are distinct because the
 * pane offers a reload for the first and cannot for the second.
 */
export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'changed' | 'missing' | 'failed' }

/**
 * Write one file of one project, refusing if it changed since it was read.
 *
 * The same containment guard `readFileInside` uses, by the same two halves:
 * `resolveInside` for the path the renderer spelled, and a `realpath` re-check
 * for the one it did not, since `writeFile` follows a symlink exactly as
 * `readFile` does.
 *
 * `expectedMtimeMs` is the mtime the text on screen was read at, which is why
 * `fsRead` has carried one since B1. A mismatch refuses and writes nothing.
 *
 * **This is check-then-write, not an atomic compare-and-swap.** A change
 * landing between the `stat` and the `writeFile` is not caught, and there is
 * no way to catch it with POSIX file APIs. The window is sub-millisecond and
 * the alternative (a lock file, or a temp-and-rename that would replace a
 * symlink the user deliberately made) is worse than the race. Said plainly
 * here so the next reader does not assume a guarantee that is not there.
 *
 * Never throws, like its sibling.
 */
export async function writeFileInside(
  root: string,
  relPath: string,
  text: string,
  expectedMtimeMs: number,
): Promise<WriteResult> {
  const target = resolveInside(root, relPath)
  if (target === null) return { ok: false, reason: 'failed' }
  let realTarget: string
  let info: Stats
  try {
    const realRoot = await realpath(root)
    realTarget = await realpath(target)
    if (!isInside(realRoot, realTarget)) return { ok: false, reason: 'failed' }
    info = await stat(realTarget)
  } catch {
    // `realpath` and `stat` both reject for a path with nothing at the end of
    // it, which is the one refusal the caller can act on differently.
    return { ok: false, reason: 'missing' }
  }
  if (!info.isFile()) return { ok: false, reason: 'failed' }
  if (info.mtimeMs !== expectedMtimeMs) return { ok: false, reason: 'changed' }
  try {
    await writeFile(realTarget, text, 'utf8')
    const written = await stat(realTarget)
    return { ok: true, mtimeMs: written.mtimeMs }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
```

Add `writeFile` to the `node:fs/promises` import and `Stats` to the `node:fs` type import. **If `resolveInside` or `isInside` are named differently in the real file, use the real names**, and if the realpath pattern there differs from this shape, follow the real one: this is the guard B1 got right after getting it wrong once.

Note the `catch` around `realpath`/`stat` answers `missing` while the outer refusals answer `failed`. Check that against the tests above: the escape cases must NOT reach that catch, because `resolveInside` refuses them first. If they do, the tests will tell you and one of the two is wrong.

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run tests/unit/fileTree.test.ts`
Record the real count.

- [ ] **Step 6: Wire the channel**

In `src/shared/ipc.ts`, add to `CHANNELS`:

```typescript
  fsWrite: 'prcli:fsWrite',
```

Declare the result beside `FileContents`, and re-export rather than re-declare if that is what `FileContents` does:

```typescript
/**
 * What a write did.
 *
 * Declared here rather than only in `src/main/files/tree.ts` for the reason
 * `FileContents` gives: the renderer draws this. A refusal is data, because
 * the pane says what happened instead of the app failing.
 */
export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'changed' | 'missing' | 'failed' }
```

Add to `PrcliApi`, beside `fsRead`:

```typescript
  /**
   * Write one file of one project, refusing if it changed since it was read.
   *
   * `relPath` is relative to the project's own `cwd` and resolved against it
   * in main: no absolute path crosses this boundary. `expectedMtimeMs` is the
   * mtime the text on screen was read at. A path that would leave the project,
   * a directory, a missing file and a changed file all resolve to an `ok:
   * false` result rather than rejecting.
   */
  fsWrite(
    projectId: string,
    relPath: string,
    text: string,
    expectedMtimeMs: number,
  ): Promise<WriteResult>
```

In `src/preload/index.ts`, beside the `fsRead` bridge:

```typescript
  fsWrite: (projectId, relPath, text, expectedMtimeMs) =>
    ipcRenderer.invoke(CHANNELS.fsWrite, projectId, relPath, text, expectedMtimeMs),
```

In `src/main/ipc/register.ts`, immediately after the `CHANNELS.fsRead` handler at roughly line 1368:

```typescript
  // Beside `fsRead` and outside `serialise` for the same reason: it touches
  // the filesystem and writes no config. Two saves of one file racing is the
  // user's own doing and the mtime check is what makes the second one refuse,
  // which is a better answer than a queue that would let it clobber silently.
  ipcMain.handle(
    CHANNELS.fsWrite,
    async (_event, projectId: string, relPath: string, text: string, expectedMtimeMs: number) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, reason: 'failed' }
      return writeFileInside(project.cwd, relPath, text, expectedMtimeMs)
    },
  )
```

Add `writeFileInside` to the existing `../files/tree` import.

- [ ] **Step 7: Extend the integration test**

Append to `tests/integration/fileTree.test.ts`, following the local-`handle` pattern that file already uses and its header's honesty about what that does and does not prove:

```typescript
async function handleWrite(
  projects: { id: string; cwd: string }[],
  projectId: string,
  relPath: string,
  text: string,
  expectedMtimeMs: number,
): Promise<WriteResult> {
  const project = projects.find((row) => row.id === projectId)
  if (!project) return { ok: false, reason: 'failed' }
  return writeFileInside(project.cwd, relPath, text, expectedMtimeMs)
}

describe('the fsWrite handler', () => {
  it('writes a file of the named project', async () => {
    const before = await readFileInside(root, 'README.md')
    const result = await handleWrite([{ id: 'p1', cwd: root }], 'p1', 'README.md', '# two', before!.mtimeMs)
    expect(result.ok).toBe(true)
    expect((await readFileInside(root, 'README.md'))?.text).toBe('# two')
  })

  it('resolves an unknown project to a refusal rather than throwing', async () => {
    const result = await handleWrite([{ id: 'p1', cwd: root }], 'nope', 'README.md', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })

  it('will not write outside the project it names', async () => {
    const result = await handleWrite([{ id: 'p1', cwd: root }], 'p1', '../../tmp/escaped.txt', 'x', 0)
    expect(result).toEqual({ ok: false, reason: 'failed' })
  })
})
```

- [ ] **Step 8: Prove the mtime check and the guard both bite**

Two mutations, run separately, each restored before the next.

First, delete `if (info.mtimeMs !== expectedMtimeMs) return { ok: false, reason: 'changed' }` and run both test files. Record which tests failed.

Second, change `if (!isInside(realRoot, realTarget))` to `if (false)` and run both again. Record which failed.

**Both "Expected" lines you might write here are hypotheses.** In B1 the identical guard mutation failed exactly ONE test rather than the four the plan implied, because `resolveInside` catches the `..` and absolute cases independently, and that asymmetry is the evidence the two halves are separate guards. Record what you actually observe, per mutation, and write it into `tests/unit/fileTree.test.ts`'s existing mutation-record header as the next numbered round. Restore both, confirm green, confirm `git diff src/main/files/tree.ts` is empty before committing.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
npm test
git add -A
git commit -m "Write one file of one project, and refuse when it moved"
```

No e2e needed: this task touches no renderer code. Say so in your report if you disagree.

---

### Task 2: CodeMirror replaces the `<pre>`

The dependency, and an editor that shows the file. No saving yet, no dirty state yet: this task ends with a pane you can type into whose changes go nowhere.

**Files:**
- Modify: `package.json` (seven dependencies)
- Create: `src/renderer/lib/languageForPath.ts`
- Create: `tests/unit/languageForPath.test.ts`
- Modify: `src/renderer/FileView.tsx`
- Modify: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes from B1: `FileView({ projectId, relPath })`, `fsRead`, `relativeToProject`, `PANE_COLORS`.
- Produces, relied on by Tasks 3, 4 and 5: `FileView` accepting `color`, `onDirtyChange` and `paneId`; testid `editor-content` still present on the editable surface.

- [ ] **Step 1: Add the dependencies and prove the gate**

```bash
npm install @codemirror/state @codemirror/view @codemirror/language @codemirror/commands @codemirror/search @codemirror/lang-javascript @codemirror/lang-markdown
npm run check-deps
```

**Expected: check-deps FAILS**, naming seven dependencies imported nowhere under `src/`. That failure is the gate working, and it is why this task adds the dependency and the code that uses it in one commit rather than two. Record the actual message.

Measured before this plan was written, so you can compare rather than guess: 18 packages on disk including `@lezer/*`, 4.7M installed, 297KB bundled and minified for the five core packages and 521KB with both language packs. If your numbers differ by a lot, say so.

- [ ] **Step 2: Write the failing unit tests for the language helper**

CodeMirror itself cannot be unit tested here (no DOM), so the one decision that CAN be tested purely is pulled out: which language a path gets.

Create `tests/unit/languageForPath.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { languageIdForPath } from '../../src/renderer/lib/languageForPath'

describe('languageIdForPath', () => {
  it('names javascript for the js and ts family', () => {
    for (const path of ['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cjs']) {
      expect(languageIdForPath(path)).toBe('javascript')
    }
  })

  it('names markdown for md', () => {
    expect(languageIdForPath('README.md')).toBe('markdown')
    expect(languageIdForPath('docs/a.markdown')).toBe('markdown')
  })

  // Everything else is plain text rather than a guess. A wrong grammar is
  // worse than none: it colours a file confidently and incorrectly.
  it('names none for anything else', () => {
    for (const path of ['a.rs', 'a.py', 'Makefile', 'a', 'a.', '.env']) {
      expect(languageIdForPath(path)).toBe(null)
    }
  })

  // The extension is the last dot's suffix, not the first: a file called
  // `component.test.ts` is TypeScript.
  it('reads the last extension, not the first', () => {
    expect(languageIdForPath('component.test.ts')).toBe('javascript')
    expect(languageIdForPath('notes.md.bak')).toBe(null)
  })

  it('is case insensitive', () => {
    expect(languageIdForPath('README.MD')).toBe('markdown')
    expect(languageIdForPath('A.TS')).toBe('javascript')
  })
})
```

Run: `npx vitest run tests/unit/languageForPath.test.ts` and record the failure.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/lib/languageForPath.ts`:

```typescript
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'

/**
 * Which grammar a path gets, or null for none.
 *
 * Split from `languageForPath` below so the decision is unit testable: vitest
 * runs with no DOM here, so a function returning a CodeMirror extension cannot
 * be asserted on, but the id it chose can.
 *
 * Unknown is null rather than a guess. A wrong grammar is worse than none: it
 * colours a file confidently and incorrectly, and this app opens whatever the
 * tree shows.
 */
export type LanguageId = 'javascript' | 'markdown' | null

export function languageIdForPath(path: string): LanguageId {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  // No dot, or a leading dot with nothing after it (`.env`, `Makefile`).
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) return 'javascript'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  return null
}

/**
 * The CodeMirror extension for a path, or none.
 *
 * `jsx: true, typescript: true` for the whole javascript family: one
 * configuration for six extensions is one thing to get right, and the parser
 * accepts plain JS under both flags.
 */
export function languageForPath(path: string): Extension[] {
  switch (languageIdForPath(path)) {
    case 'javascript':
      return [javascript({ jsx: true, typescript: true })]
    case 'markdown':
      return [markdown()]
    default:
      return []
  }
}
```

Run the unit file again and record it passing.

- [ ] **Step 4: Replace the `<pre>` with CodeMirror**

In `src/renderer/FileView.tsx`, keep everything about the fetch, the `live` flag, the missing state and `editor-missing` exactly as it is. Replace only the `<pre>` branch.

```typescript
import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { languageForPath } from './lib/languageForPath'
import { PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'
```

The view is created once per file and destroyed on unmount:

```typescript
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)

  useEffect(() => {
    if (text === null || host.current === null) return
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        ...languageForPath(relPath ?? ''),
        // The pane's own background, read rather than hardcoded, for the
        // reason `Terminal.tsx` gives where it repeats `--color-term-fg` by
        // hand: a coloured editor pane and a coloured terminal pane sitting in
        // one row must not disagree. `PANE_COLORS` is chosen so `#d4d4d8`
        // stays legible on every entry, so the foreground is that same value.
        EditorView.theme({
          '&': { backgroundColor: color, color: '#d4d4d8', height: '100%' },
          '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
          '.cm-gutters': { backgroundColor: color, color: '#3f3f46', border: 'none' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })
    const created = new EditorView({ state, parent: host.current })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
  }, [text, relPath, color])
```

and the render becomes:

```typescript
  return (
    <div
      data-testid="editor-content"
      ref={host}
      className="scroll-thin h-full overflow-auto text-[11px]"
    />
  )
```

**Three things to check rather than assume, and report what you found:**

1. `data-testid="editor-content"` moves from a `<pre>` to the host `<div>`. B1's e2e asserts `toContainText` on it, and CodeMirror renders the document into `.cm-content` inside that host, so `textContent` should still contain the file. **Verify by running B1's existing tests, not by reasoning.** If CodeMirror virtualises long documents so only visible lines are in the DOM, a `toContainText` on a long file would start failing: the fixtures are short, so this should not bite here, but say in your report whether you checked.
2. The `text` state is now the INITIAL document only. Re-running the effect on every `text` change would destroy and rebuild the editor mid-typing, which is why nothing in Task 3 sets `text` after the first fetch. Note it in a comment.
3. `color` is a new prop. Add it as `color: PaneColor` defaulting to `PANE_COLOR_DEFAULT`, and pass it from `App.tsx`'s pane render where `<Terminal color=...>` already gets one. Keep the `<Terminal>` props exactly as they are.

- [ ] **Step 5: Extend the e2e**

Append to `tests/e2e/editor.spec.ts`, following that file's existing shape and its shared-`page`-in-order convention:

```typescript
test('the editor is editable and shows the file', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = page.getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })

  // Typing reaches the document. Not `toBeVisible`, which has passed on this
  // project for an element painted behind the terminal.
  await content.locator('.cm-content').click()
  await page.keyboard.type('X')
  await expect(content).toContainText('X')
})

test('a javascript file is syntax highlighted and a plain one is not', async () => {
  // The observable difference is that CodeMirror emits token spans for a
  // grammar it has and none for one it does not. Asserting on a class the
  // theme happens to use would pin the theme; this pins that a language was
  // applied at all.
  await page.getByTestId('tree-row-src').click()
  await page.getByTestId('tree-row-src/app.ts').click()
  await expect(page.getByTestId('editor-content').locator('.cm-content span').first()).toBeAttached()
})
```

**The second test's mechanism is a hypothesis.** Verify what CodeMirror actually emits for a highlighted document versus a plain one in this setup, and if spans appear either way, find the difference that is real and assert on that instead. Do not weaken it to whatever passes, and say in your report what you settled on and why.

- [ ] **Step 6: Run everything**

```bash
npm run typecheck
npm test
npm run e2e
npm run check-deps
```

`check-deps` must now be clean: all seven packages are imported (five in `FileView.tsx`, two in `languageForPath.ts`). If it still complains, the named package is unused and either the import is missing or the dependency should not have been added. Record the real e2e count, and run the FULL suite: this task changes what every editor pane renders, and `splits.spec.ts` encodes the pane row's geometry in pixel constants.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Show a file in a real editor"
```

---

### Task 3: A dirty pane says so

Editing marks the pane dirty; the tab draws a dot. Still nothing saves.

**Files:**
- Create: `src/renderer/lib/dirtyPanes.ts`
- Create: `tests/unit/dirtyPanes.test.ts`
- Modify: `src/renderer/FileView.tsx` (an `onDirtyChange` prop)
- Modify: `src/renderer/App.tsx` (the dirty map, passed down)
- Modify: `src/renderer/TabBar.tsx` (the dot)
- Modify: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes from Task 2: `FileView` with its CodeMirror view.
- Produces, relied on by Tasks 4 and 5: `dirty: Record<string, boolean>` in `App.tsx`, `setDirty(paneId, boolean)`, and testid `editor-dirty-<paneId>` on the dot.

- [ ] **Step 1: Write the failing unit tests for the pure part**

The map operations are pure and the component is not, so the map is what gets tested.

Create `tests/unit/dirtyPanes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { markDirty, forgetPane, anyDirty } from '../../src/renderer/lib/dirtyPanes'

describe('markDirty', () => {
  it('records a pane as dirty', () => {
    expect(markDirty({}, 'p1', true)).toEqual({ p1: true })
  })

  // Clean is absence, not `false`. One representation of "not dirty", for the
  // reason `PANE_COLOR_DEFAULT` gives about one spelling on disk: `anyDirty`
  // and the dot both read this map and must not disagree about which of two
  // spellings means clean.
  it('removes a pane rather than storing false', () => {
    expect(markDirty({ p1: true }, 'p1', false)).toEqual({})
  })

  // Referential identity matters: this map is React state, and a new object
  // for an unchanged value re-renders the whole tab bar on every keystroke.
  it('returns the same object when nothing changes', () => {
    const was = { p1: true }
    expect(markDirty(was, 'p1', true)).toBe(was)
    const clean = {}
    expect(markDirty(clean, 'p1', false)).toBe(clean)
  })
})

describe('forgetPane', () => {
  it('drops a closed pane', () => {
    expect(forgetPane({ p1: true, p2: true }, 'p1')).toEqual({ p2: true })
  })

  // A pane that was never dirty is closed constantly. Same identity rule.
  it('returns the same object when the pane was not in it', () => {
    const was = { p1: true }
    expect(forgetPane(was, 'p2')).toBe(was)
  })
})

describe('anyDirty', () => {
  it('is false for an empty map and true for a populated one', () => {
    expect(anyDirty({})).toBe(false)
    expect(anyDirty({ p1: true })).toBe(true)
  })
})
```

Run it and record the failure.

- [ ] **Step 2: Implement the map**

Create `src/renderer/lib/dirtyPanes.ts`:

```typescript
/**
 * Which panes have unsaved edits.
 *
 * A plain map in `App.tsx` rather than state inside each pane, because the two
 * things that need the answer are outside the pane: the tab bar draws the dot,
 * and the close path has to ask before destroying the pane. Neither can reach
 * inside a `FileView`.
 *
 * Never persisted. A pane that was dirty when the app closed reopens showing
 * what is on disk, because what is on disk is all that survived. The store
 * learns nothing about dirtiness in this slice.
 */
export type DirtyPanes = Record<string, boolean>

/**
 * `panes` with `paneId` marked, or the same object if that changes nothing.
 *
 * Clean is ABSENCE rather than `false`: one spelling of "not dirty", so the
 * dot and `anyDirty` cannot disagree. The identity return is load-bearing and
 * not a micro-optimisation: this runs on every keystroke, and a fresh object
 * each time re-renders the whole tab bar while the user is typing.
 */
export function markDirty(panes: DirtyPanes, paneId: string, dirty: boolean): DirtyPanes {
  if (dirty === (panes[paneId] === true)) return panes
  if (!dirty) {
    const next = { ...panes }
    delete next[paneId]
    return next
  }
  return { ...panes, [paneId]: true }
}

/** `panes` without `paneId`, or the same object if it was not in it. */
export function forgetPane(panes: DirtyPanes, paneId: string): DirtyPanes {
  if (panes[paneId] === undefined) return panes
  const next = { ...panes }
  delete next[paneId]
  return next
}
```

Two functions, not three. An `anyDirty` helper would be the natural third and nothing in this slice calls it: the only caller it would ever have is a prompt on window close, and this slice deliberately does not add one (Task 6 Step 2 records that as a known gap). Do not add it speculatively.

Run the unit file and record it passing.

- [ ] **Step 3: Report dirtiness from the editor**

In `FileView.tsx`, add `paneId: string` and `onDirtyChange: (paneId: string, dirty: boolean) => void` props, and an update listener in the extension list:

```typescript
        // The baseline is the document the view was created with, so dirty is
        // "differs from what was read", not "was typed in". Typing a character
        // and deleting it again leaves the pane clean, which is what the dot
        // has to mean for the close prompt to be worth showing.
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          onDirtyChange(paneId, update.state.doc.toString() !== baseline.current)
        }),
```

with `const baseline = useRef(text ?? '')` kept in step with the document the view was built from, and reset when a save succeeds (Task 4 does that half). **Check the effect's dependency list**: adding `onDirtyChange` and `paneId` to it must not cause the view to be destroyed and rebuilt on every render, which would drop the cursor. If the handler is not stable, wrap it in `useCallback` at the `App.tsx` end rather than removing it from the deps and lying to the linter.

Report a pane clean when it unmounts, so a closed pane leaves nothing behind in the map.

- [ ] **Step 4: Hold the map in `App.tsx` and draw the dot**

In `App.tsx`:

```typescript
  const [dirty, setDirtyPanes] = useState<DirtyPanes>({})
  const onDirtyChange = useCallback((paneId: string, isDirty: boolean) => {
    setDirtyPanes((was) => markDirty(was, paneId, isDirty))
  }, [])
```

Pass `dirty` to `TabBar`. In `TabBar.tsx`, beside where `tombstoned` is computed, a tab is dirty when the pane it holds is:

```typescript
        // An editor tab holds exactly one pane and its id IS the tab's id for
        // a one-pane tab, which is every editor tab this slice can make. A
        // split tab holding an edited editor is not reachable yet, because
        // Cmd+D on an editor pane is still deferred. When it lands, this needs
        // to ask whether ANY pane of the tab is dirty rather than the tab's own
        // id, and the test below is what will fail.
        const unsaved = dirty[tab.id] === true
```

and render the dot inside the tab, before the close button:

```typescript
            {unsaved && (
              <span
                data-testid={`editor-dirty-${tab.id}`}
                title="Unsaved changes"
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-fg"
              />
            )}
```

**Read `StatusDot.tsx` before writing that span.** If it already draws a dot of this shape, use it rather than a second one, and say which you did. Two dot implementations that drift apart is the shape of defect this codebase has hit with label rules and restart gates.

- [ ] **Step 5: Extend the e2e**

```typescript
test('typing marks the tab dirty and undoing marks it clean', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = page.getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })

  const tabId = await page.getByTestId('tabbar').locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')

  await content.locator('.cm-content').click()
  await page.keyboard.type('X')
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toBeAttached()

  // Back to what was read, so the dot goes. Dirty means "differs from disk",
  // not "was typed in", and this is the assertion that tells the two apart.
  await page.keyboard.press('Meta+z')
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toHaveCount(0)
})
```

- [ ] **Step 6: Prove the dot is load-bearing**

Change `markDirty`'s first line to `return panes`, run the unit file and the e2e spec, and record what failed in each. Restore, confirm green, confirm an empty `git diff`.

**Do not assume both suites fail.** Record which did. If the unit tests fail and the e2e passes, that tells you the e2e is asserting something the unit tests already cover and the e2e is not pulling its weight, which is worth saying.

- [ ] **Step 7: Full verification and commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Show a dot on a tab with unsaved edits"
```

---

### Task 4: ⌘S saves, and refuses when the file moved

**Files:**
- Modify: `src/renderer/FileView.tsx` (the save, the refusal banner, the reload)
- Modify: `src/renderer/App.tsx` (the ⌘S binding)
- Modify: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes from Task 1: `window.prcli.fsWrite`. From Task 3: the dirty map.
- Produces, relied on by Task 5: a saved pane is clean; testids `editor-refused` and `editor-reload`.

- [ ] **Step 1: Read how a shortcut reaches a pane**

Read `App.tsx`'s `onKeyDown` handler (search for `event.metaKey`). Note three things it already establishes, all of which bind you:

- `data-shortcuts="off"` opts an element out, and xterm's textarea deliberately does NOT carry it, which is why ⌘W works in a terminal. **CodeMirror's editable surface must not carry it either**, or ⌘S will never reach the app.
- Bindings test `event.code`, not `event.key`, because ⌥ rewrites `key` on macOS.
- These are window-level bindings rather than registered menu accelerators, because an accelerator the menu claims never reaches the window.

Report which of those you had to work around.

- [ ] **Step 2: Write the failing e2e**

```typescript
test('Cmd+S writes the file and clears the dot', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = page.getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })
  const tabId = await page.getByTestId('tabbar').locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')

  await content.locator('.cm-content').click()
  await page.keyboard.type('X')
  await page.keyboard.press('Meta+s')

  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toHaveCount(0)
  // The assertion this test exists for: what is on DISK, not what is on
  // screen. A save that cleared the dot without writing would pass every
  // visual assertion here.
  await expect
    .poll(async () => readFile(join(projectCwd, 'README.md'), 'utf8'), { timeout: 5_000 })
    .toContain('X')
})

test('a file changed underneath the pane refuses the save and offers a reload', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = page.getByTestId('editor-content')
  await content.locator('.cm-content').click()
  await page.keyboard.type('Y')

  // Somebody else, which on this machine is the normal case.
  await writeFile(join(projectCwd, 'README.md'), '# theirs\n')

  await page.keyboard.press('Meta+s')
  await expect(page.getByTestId('editor-refused')).toBeVisible({ timeout: 10_000 })

  // Refused means refused: their text is still on disk.
  expect(await readFile(join(projectCwd, 'README.md'), 'utf8')).toBe('# theirs\n')

  await page.getByTestId('editor-reload').click()
  await expect(content).toContainText('# theirs')
  await expect(page.getByTestId('editor-refused')).toHaveCount(0)
})
```

Run and record the failures.

- [ ] **Step 3: Implement the save**

In `FileView.tsx`, hold the mtime the text was read at, and save from a handler the pane exposes:

```typescript
  const mtime = useRef<number | null>(null)
  const [refused, setRefused] = useState<null | 'changed' | 'missing' | 'failed'>(null)
```

Set `mtime.current` from the `fsRead` result in the existing fetch. The save:

```typescript
  const save = useCallback(async () => {
    const current = view.current
    if (current === null || relPath === null || mtime.current === null) return
    const text = current.state.doc.toString()
    const result = await window.prcli.fsWrite(projectId, relPath, text, mtime.current)
    if (result.ok) {
      // The baseline moves to what was just written, so the pane is clean
      // against the file rather than against what it was opened with.
      baseline.current = text
      mtime.current = result.mtimeMs
      setRefused(null)
      onDirtyChange(paneId, false)
      return
    }
    setRefused(result.reason)
  }, [projectId, relPath, paneId, onDirtyChange])
```

The refusal banner sits above the editor rather than replacing it, because the user's unsaved text is the thing they must not lose:

```typescript
      {refused !== null && (
        <div data-testid="editor-refused" className="border-b border-border bg-surface px-3 py-2 text-[11px] text-fg">
          {refused === 'changed'
            ? 'That file changed on disk since you opened it. Your edits are still here.'
            : refused === 'missing'
              ? 'That file is no longer there. Your edits are still here.'
              : 'That file could not be written.'}
          {refused === 'changed' && (
            <button data-testid="editor-reload" onClick={reload} className="ml-2 underline">
              Reload and lose my edits
            </button>
          )}
        </div>
      )}
```

`reload` re-runs the fetch, replaces the document, resets the baseline and the mtime, and clears both `refused` and the dirty flag. **Replacing a CodeMirror document is a `dispatch` with a full-length change, not a new `EditorState`**, unless you rebuild the view; either is defensible, so pick one and say which and why.

Note the copy on the button says plainly that edits are lost. Do not soften it to "Reload".

- [ ] **Step 4: Bind ⌘S**

In `App.tsx`'s `onKeyDown`, beside the `KeyW` and `KeyD` cases:

```typescript
      if (event.code === 'KeyS' && !event.altKey && activePaneId) {
        event.preventDefault()
        saveActivePane()
        return
      }
```

`saveActivePane` has to reach a mounted pane, and **this codebase already has exactly one way of doing that**, so follow it rather than inventing a second. `src/renderer/Terminal.tsx:15` holds a module-level `const mounted = new Map<string, XTerm>()`, registers each terminal into it on mount (`:72`), deletes it on unmount guarded by identity (`:113`, `if (mounted.get(tabId) === term)`), and exports a lookup that `App.tsx` calls without a ref chain. `paneGrid` is that lookup, which is why `splitActive` can answer "no terminal is mounted for the selection".

Do the same in `FileView.tsx`: a module-level `Map<string, EditorView>` keyed by pane id, an export like `saveEditorPane(paneId): Promise<void>` or `editorOf(paneId)`, and the same identity-guarded delete on unmount. The identity guard is not optional: without it, a remount that runs the new effect before the old cleanup deletes the live entry, and the export starts answering "nothing mounted" for a pane that is on screen.

Report which shape you took and whether `Terminal.tsx`'s pattern needed adapting.

- [ ] **Step 5: Run and record**

Run: `npm run e2e -- tests/e2e/editor.spec.ts`, then the full suite. Record per test.

- [ ] **Step 6: Prove the mtime check reaches the user**

Change the handler in `register.ts` to pass `info.mtimeMs` as the expected value instead of the renderer's (that is, make the check always agree with itself), and run the spec file.

Expected: `a file changed underneath the pane refuses the save and offers a reload` fails, and it should fail on the DISK assertion, not only the banner one. Record which assertion failed first, because "the banner did not appear" and "their text was overwritten" are different failures and only the second is the one that matters. Restore, confirm green, confirm an empty `git diff`.

- [ ] **Step 7: Full verification and commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Save with Cmd+S, and refuse a file that moved"
```

---

### Task 5: Closing a dirty pane asks

**Files:**
- Modify: `src/renderer/App.tsx` (the close path, the dialog)
- Create: `src/renderer/ConfirmClosePane.tsx`
- Modify: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes from Task 3: the dirty map. From Task 4: a saved pane is clean.
- Produces: nothing later depends on.

- [ ] **Step 1: Read the close path and the dialog pattern**

`closePane` in `App.tsx` is four lines and calls straight through to the channel. Both routes into it matter: the tab's close button, and ⌘W. Read `AddProjectDialog.tsx` for how this app builds a dialog (`ui/Dialog`, Radix underneath) and follow it rather than inventing one.

- [ ] **Step 2: Write the failing e2e**

```typescript
test('closing a dirty editor pane asks first, and cancelling keeps it', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = page.getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })
  const tabId = await page.getByTestId('tabbar').locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')

  await content.locator('.cm-content').click()
  await page.keyboard.type('Z')
  await page.getByTestId(`close-${paneId}`).click()

  await expect(page.getByTestId('confirm-close')).toBeVisible()
  await page.getByTestId('confirm-close-cancel').click()
  // Still open, still dirty, still holding the edit.
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(1)
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toBeAttached()
})

test('confirming the prompt closes it and loses the edit', async () => {
  const tabId = await page.getByTestId('tabbar').locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')
  await page.getByTestId(`close-${paneId}`).click()
  await page.getByTestId('confirm-close-discard').click()
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
  // The file on disk never had the edit, and still does not.
  expect(await readFile(join(projectCwd, 'README.md'), 'utf8')).not.toContain('Z')
})

test('closing a clean editor pane does not ask', async () => {
  // The control. Without it, a prompt that appeared for every pane would pass
  // both tests above.
  await page.getByTestId('tree-row-README.md').click()
  await expect(page.getByTestId('editor-content')).toContainText('# demo', { timeout: 10_000 })
  const tabId = await page.getByTestId('tabbar').locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')
  await page.getByTestId(`close-${paneId}`).click()
  await expect(page.getByTestId('confirm-close')).toHaveCount(0)
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
})

test('closing a terminal pane does not ask', async () => {
  // The other control, and the one that catches a prompt keyed on the wrong
  // thing: a terminal is never dirty, so it must never be asked about.
})
```

**Fill the last body against the real markup**, and check `close-` is the real prefix for a tab's close button before relying on it.

- [ ] **Step 3: Implement**

`ConfirmClosePane.tsx` follows `AddProjectDialog.tsx`'s shape: a `Dialog` with a title, one sentence, and two buttons (`confirm-close-cancel`, `confirm-close-discard`). The discard copy must say what it does, like the reload button in Task 4.

In `App.tsx`, `closePane` gains a guard before the channel call:

```typescript
  // The prompt is only for a pane with unsaved edits. A terminal pane is never
  // in this map, so this is not a kind test wearing a dirtiness costume: a
  // terminal closing has always been immediate and stays that way.
  const requestClosePane = useCallback(
    (paneId: string) => {
      if (dirty[paneId] === true) {
        setPendingClose(paneId)
        return
      }
      closePane(paneId)
    },
    [dirty, closePane],
  )
```

Route BOTH the tab close button and ⌘W through `requestClosePane`. **Check there is no third caller** with `grep -n "closePane(" src/renderer/App.tsx`, and if there is, decide whether it should prompt and say why in your report.

On discard, call `closePane` and then `forgetPane` the id out of the dirty map.

- [ ] **Step 4: Run, record, and prove it bites**

Run the spec file, then the full suite, and record both.

Then mutate: make `requestClosePane` always call `closePane` directly. Record which tests fail. Expected is the two dirty ones and NOT the two controls, and if a control also fails, the control is not measuring what it claims. Restore, confirm green, confirm an empty `git diff`.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Ask before closing a pane with unsaved edits"
```

---

### Task 6: The edit survives a relaunch, and the sweep

The spec's own end-to-end test, plus the surfaces a second pane kind touches.

**Files:**
- Modify: `tests/e2e/editorRestore.spec.ts`
- Modify: `tests/e2e/editor.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: The spec's test, written as the spec words it**

Append to `tests/e2e/editorRestore.spec.ts`, which already seeds its own config and has a working `relaunch`:

```typescript
// The spec's own acceptance test for this slice: open a file, edit, save,
// relaunch, and find the edit. Note what it does NOT assert: that the pane was
// still dirty. Dirtiness is renderer state and is deliberately not persisted,
// so a pane that was dirty at quit reopens clean against what is on disk.
test('an edit saved before a relaunch is there afterwards', async () => {
  await expect(page.getByTestId('pane-e1')).toBeVisible({ timeout: 10_000 })
  const content = page.getByTestId('editor-content')
  await content.locator('.cm-content').click()
  await page.keyboard.type('// edited\n')
  await page.keyboard.press('Meta+s')
  await expect(page.getByTestId('editor-dirty-e1')).toHaveCount(0)

  await relaunch()
  await expect(page.getByTestId('editor-content')).toContainText('// edited', { timeout: 10_000 })
})
```

- [ ] **Step 2: The dirty-state-is-not-persisted test**

```typescript
test('an unsaved edit is gone after a relaunch, and the tab is clean', async () => {
  const content = page.getByTestId('editor-content')
  await content.locator('.cm-content').click()
  await page.keyboard.type('// not saved')
  await expect(page.getByTestId('editor-dirty-e1')).toBeAttached()

  await relaunch()
  await expect(page.getByTestId('editor-content')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('editor-content')).not.toContainText('// not saved')
  await expect(page.getByTestId('editor-dirty-e1')).toHaveCount(0)
})
```

Note `app.close()` is what `relaunch` does, and a real quit with unsaved work is a case this slice does NOT handle: nothing prompts on window close. Say so in your report as a known gap rather than adding a prompt here.

- [ ] **Step 3: Check the surfaces a second pane kind touches**

Each is one assertion, and **each may already pass**. Write the test, run it, and only change code if it fails. Record which already passed.

1. **The command palette** names an editor tab the way the tab bar does. `tabLabel` is the one rule and B1 made the editor its fourth caller, so this should hold. Assert it.
2. **A coloured editor pane** actually paints its colour. Right-click the pane, pick a swatch, and assert the editor's background is the chosen colour rather than the default. This is the one Task 2 wired and nothing has tested.
3. **Two editor panes on one file** in two tabs. Edit one, save, and assert the other does NOT silently show the old text and cannot overwrite the new one: its next save must refuse, because its mtime is stale. That is the mtime check doing exactly what it exists for, inside one app.

- [ ] **Step 4: Run the full suite and record**

Run: `npm run e2e`

Record the total against this slice's starting baseline of **87 passed, 0 failed**. Known flake, not yours: `notes.spec.ts:134` counts tabs immediately after clicking `new-tab` with no polling and can go red on timing.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
npm test
npm run e2e
git add -A
git commit -m "Prove a saved edit outlives the app"
```

---

## Risks carried into execution

1. **CodeMirror cannot be unit tested here.** Everything decidable in pure code has been pulled into `src/renderer/lib/` for that reason. If a task tempts you to test the editor itself in vitest, that is the signal to move the logic, not to add a DOM.
2. **The mtime check is check-then-write, not atomic.** Stated in the code. A reviewer who calls it a compare-and-swap has misread it.
3. **`splits.spec.ts` encodes the pane row's geometry in pixel constants** and counts `[data-testid^="pane-"]`, which also matches `pane-divider`. Every task here changes what a pane can contain: run the full e2e suite, not just the new spec.
4. **A failed Playwright test requeues the rest of its file**, reloading it and rerunning `beforeAll` against fresh temp dirs and a fresh app, once per failure, AFTER `afterAll` has removed the dirs and killed the tmux socket. A red after a red says nothing until the first is fixed. Read out of `@playwright/test` 1.62.0's source, not inferred.
5. **`posix_spawnp failed` or `fork failed: Device not configured` means the machine is out of ptys**, not that the branch broke. Attribute with `lsof /dev/ptmx | awk 'NR>1{print $2}' | sort | uniq -c | sort -rn | head` and report it. A long-running instance of this very app held 321 of the machine's 511 handles on 2026-08-04.
6. **This plan's own predictions are hypotheses.** B1's plan predicted nine things that turned out false, including a fixture that seeded a flat tab row the store drops entirely, and a fixture that read the wrong state map so its test would have passed with the rule under test deleted. Where a step says "Expected", treat it as something to test, and write down what actually happened.
