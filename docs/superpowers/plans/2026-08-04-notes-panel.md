# NOTES Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collapsible per-project freeform notes column at the right edge of the window, auto-saving to `~/.prcli/notes/<projectId>.md`.

**Architecture:** A tiny main-process file store (atomic write, never-throwing read) behind two new IPC channels; a renderer `NotesPanel` component with a debounced saver whose pending record captures the project id at edit time; collapse state in `localStorage`. Spec: `docs/superpowers/specs/2026-08-04-notes-panel-design.md`.

**Tech Stack:** Electron (main/preload/renderer split), React 19, Tailwind 4, vitest (`npm test`), Playwright e2e (`npm run e2e`), `npm run typecheck`.

## Global Constraints

- Work on branch `notes-panel` off `master`; repo merges feature branches into master.
- No em dashes anywhere: code, comments, commit messages.
- Storage path: `<configRoot()>/notes/<projectId>.md`. `configRoot()` is exported from `src/main/state/store.ts:367` and honours `PRCLI_CONFIG_DIR`, which is what keeps tests off the real `~/.prcli`.
- Note module read NEVER throws; write refuses ids containing `/` or `..` (no-op / `''`).
- Test id prefix `notes-` only. NEVER add test ids under prefixes `tab-` or `skill-`: e2e counts elements by those prefixes (`[data-testid^="tab-"]` etc.).
- The textarea MUST carry `data-shortcuts="off"`. The `App.tsx:577` keydown guard exempts such elements; without it ⌘W typed mid-note closes a pane and destroys its tmux session.
- Autosave: 500ms debounce, flushed on blur, project switch, unmount. Flush writes under the project id captured at edit time.
- Collapse state: `localStorage` key `prcli:notesCollapsed`, `'1'` when collapsed, key removed when expanded. Global across projects.
- Renderer swallows write failures (same policy as the skills fetch in `RightPanel.tsx:34-39`).
- E2E specs must launch through `tests/e2e/harness.ts` `launchApp` (five required overrides) and use a socket starting with `prcli-e2e`.

---

### Task 1: Main-process note store

**Files:**
- Create: `src/main/notes/store.ts`
- Test: `tests/unit/notes.test.ts`

**Interfaces:**
- Consumes: `configRoot()` from `src/main/state/store.ts`.
- Produces: `readNote(projectId: string): Promise<string>` and `writeNote(projectId: string, text: string): Promise<void>`, imported by Task 2's IPC handlers.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/notes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// afterEach both removes the temp dir and restores PRCLI_CONFIG_DIR, the same
// pairing store.test.ts uses.
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNote, writeNote } from '../../src/main/notes/store'

let dir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-notes-'))
  previousConfigDir = process.env.PRCLI_CONFIG_DIR
  process.env.PRCLI_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.PRCLI_CONFIG_DIR
  else process.env.PRCLI_CONFIG_DIR = previousConfigDir
  await rm(dir, { recursive: true, force: true })
})

describe('readNote', () => {
  it('resolves to the empty string when no note file exists', async () => {
    expect(await readNote('p1')).toBe('')
  })

  it('resolves to the empty string for an id containing a slash', async () => {
    expect(await readNote('../../etc/passwd')).toBe('')
  })
})

describe('writeNote', () => {
  it('roundtrips text through the notes directory', async () => {
    await writeNote('p1', 'startup: npm run dev')
    expect(await readNote('p1')).toBe('startup: npm run dev')
  })

  it('creates the notes directory on first write, and only the note file', async () => {
    await writeNote('p1', 'x')
    // One entry, and it is the note itself: also proves the temp file used by
    // the atomic write was renamed away rather than left behind.
    expect(await readdir(join(dir, 'notes'))).toEqual(['p1.md'])
  })

  it('overwrites an existing note rather than appending', async () => {
    await writeNote('p1', 'first')
    await writeNote('p1', 'second')
    expect(await readNote('p1')).toBe('second')
  })

  it('is a no-op for an id containing ..', async () => {
    await writeNote('..', 'refused')
    // The refusal happens before mkdir, so the directory never appears.
    await expect(readdir(join(dir, 'notes'))).rejects.toThrow()
  })

  it('preserves an empty string as an empty note', async () => {
    await writeNote('p1', 'something')
    await writeNote('p1', '')
    expect(await readNote('p1')).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/notes.test.ts`
Expected: FAIL, cannot resolve `../../src/main/notes/store`.

- [ ] **Step 3: Write the implementation**

Create `src/main/notes/store.ts`:

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'

/**
 * Where a project's note lives, or null for an id this module refuses.
 *
 * Ids are app-allocated and never user text, so the `/` and `..` check is
 * cheap insurance rather than a sanitisation layer: an id that would escape
 * `notes/` reads as empty and writes nowhere.
 */
function notePath(projectId: string): string | null {
  if (projectId.length === 0 || projectId.includes('/') || projectId.includes('..')) return null
  return join(configRoot(), 'notes', `${projectId}.md`)
}

/** The note's text, `''` for no note. Never rejects, like `ConfigStore.read`. */
export async function readNote(projectId: string): Promise<string> {
  const path = notePath(projectId)
  if (path === null) return ''
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** Serialise-free atomic write: temp file in the same directory, then rename. */
export async function writeNote(projectId: string, text: string): Promise<void> {
  const path = notePath(projectId)
  if (path === null) return
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/notes.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Run the whole unit suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/notes/store.ts tests/unit/notes.test.ts
git commit -m "Add the per-project note store: atomic write, never-throwing read"
```

---

### Task 2: IPC channels, handlers and preload entries

**Files:**
- Modify: `src/shared/ipc.ts` (CHANNELS object near line 6; `PrcliApi` near the `skills` entry at line 511)
- Modify: `src/main/ipc/register.ts` (imports near line 42; handlers at the end of the register function, after the `skills` handler at line 1305)
- Modify: `src/preload/index.ts` (api object, after `skills` at line 68)

**Interfaces:**
- Consumes: `readNote` / `writeNote` from Task 1.
- Produces: `window.prcli.notesRead(projectId: string): Promise<string>` and `window.prcli.notesWrite(projectId: string, text: string): Promise<void>`, used by Task 4's component. (`src/renderer/global.d.ts` already types `window.prcli` as `PrcliApi`, so no renderer typing change is needed.)

- [ ] **Step 1: Add the channels**

In `src/shared/ipc.ts`, add to the `CHANNELS` object after `skills: 'prcli:skills',`:

```ts
  notesRead: 'prcli:notesRead',
  notesWrite: 'prcli:notesWrite',
```

- [ ] **Step 2: Add the API surface**

In `src/shared/ipc.ts`, inside `interface PrcliApi`, after the `skills(projectCwd: string)` member:

```ts
  /** The project's note text, `''` when none has been written. */
  notesRead(projectId: string): Promise<string>
  /**
   * Overwrite the project's note. Atomic on disk; the renderer treats it as
   * fire-and-forget and swallows a rejection, since the text is still on
   * screen and this panel is not where transport faults get reported.
   */
  notesWrite(projectId: string, text: string): Promise<void>
```

- [ ] **Step 3: Register the handlers**

In `src/main/ipc/register.ts`, add to the import block:

```ts
import { readNote, writeNote } from '../notes/store'
```

Then directly after the `CHANNELS.skills` handler line:

```ts
  // Like `skills` above, deliberately not inside `serialise`: notes live in
  // their own files beside config.json, never inside it, so there is nothing
  // to serialise against and no deadlock risk to buy.
  ipcMain.handle(CHANNELS.notesRead, (_event, projectId: string) => readNote(projectId))
  ipcMain.handle(CHANNELS.notesWrite, (_event, projectId: string, text: string) =>
    writeNote(projectId, text),
  )
```

- [ ] **Step 4: Forward from preload**

In `src/preload/index.ts`, add to the `api` object after the `skills` entry:

```ts
  notesRead: (projectId) => ipcRenderer.invoke(CHANNELS.notesRead, projectId),
  notesWrite: (projectId, text) => ipcRenderer.invoke(CHANNELS.notesWrite, projectId, text),
```

- [ ] **Step 5: Typecheck and run unit tests**

Run: `npm run typecheck && npm test`
Expected: green. The typecheck is the real gate here: `api: PrcliApi` in preload fails to compile if either entry is missing or misspelt.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/register.ts src/preload/index.ts
git commit -m "Wire notesRead and notesWrite through IPC and the preload bridge"
```

---

### Task 3: Debounced note saver (renderer lib)

**Files:**
- Create: `src/renderer/lib/noteSaver.ts`
- Test: `tests/unit/noteSaver.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the write callback is injected).
- Produces: `createNoteSaver(write: (projectId: string, text: string) => void, delayMs?: number): NoteSaver` where `NoteSaver` is `{ edit(projectId: string, text: string): void; flush(): void }`. Task 4's component constructs one with `delayMs` defaulted (500).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/noteSaver.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createNoteSaver } from '../../src/renderer/lib/noteSaver'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createNoteSaver', () => {
  it('writes once after the delay, with the last text', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 's')
    saver.edit('p1', 'st')
    vi.advanceTimersByTime(499)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('p1', 'st')
  })

  it('restarts the delay on every edit', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'a')
    vi.advanceTimersByTime(400)
    saver.edit('p1', 'ab')
    vi.advanceTimersByTime(400)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(write).toHaveBeenCalledWith('p1', 'ab')
  })

  it('flush writes immediately and cancels the timer', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'a')
    saver.flush()
    expect(write).toHaveBeenCalledWith('p1', 'a')
    vi.advanceTimersByTime(1000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flush with nothing pending writes nothing', () => {
    const write = vi.fn()
    createNoteSaver(write, 500).flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('a second flush after the first writes nothing more', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'a')
    saver.flush()
    saver.flush()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('an edit under a new project id flushes the old project first', () => {
    // The race the spec calls out: text typed under project A must never be
    // written under project B's id because a switch landed mid-debounce.
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'note for p1')
    saver.edit('p2', 'note for p2')
    expect(write).toHaveBeenCalledWith('p1', 'note for p1')
    vi.advanceTimersByTime(500)
    expect(write).toHaveBeenCalledWith('p2', 'note for p2')
    expect(write).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/noteSaver.test.ts`
Expected: FAIL, cannot resolve `../../src/renderer/lib/noteSaver`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/lib/noteSaver.ts`:

```ts
/**
 * Debounced per-project note writes.
 *
 * The pending record carries the project id captured at edit time, which is
 * the whole point: `flush` on a project switch writes the OLD project's text
 * under the OLD project's id, never the one the panel is switching to. An
 * edit arriving under a different id than the pending one flushes the old
 * record first rather than dropping it.
 */
export interface NoteSaver {
  edit(projectId: string, text: string): void
  flush(): void
}

export function createNoteSaver(
  write: (projectId: string, text: string) => void,
  delayMs = 500,
): NoteSaver {
  let pending: { projectId: string; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending === null) return
    const { projectId, text } = pending
    pending = null
    write(projectId, text)
  }

  return {
    edit(projectId, text) {
      if (pending !== null && pending.projectId !== projectId) flush()
      pending = { projectId, text }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    flush,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/noteSaver.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/noteSaver.ts tests/unit/noteSaver.test.ts
git commit -m "Add the debounced note saver, id captured at edit time"
```

---

### Task 4: NotesPanel component and App integration

**Files:**
- Create: `src/renderer/NotesPanel.tsx`
- Modify: `src/renderer/App.tsx` (import block near line 7; the flex row slot directly after `{panelOpen ? <RightPanel .../> : null}` which closes at line 977)

**Interfaces:**
- Consumes: `window.prcli.notesRead` / `window.prcli.notesWrite` (Task 2), `createNoteSaver` (Task 3), `ProjectDescriptor` from `../shared/ipc`.
- Produces: `NotesPanel({ project }: { project: ProjectDescriptor | undefined })`, rendered by `App`. Test ids `notes-panel`, `notes-toggle`, `notes-textarea`, `notes-empty` for Task 5.

- [ ] **Step 1: Write the component**

Create `src/renderer/NotesPanel.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { ProjectDescriptor } from '../shared/ipc'
import { createNoteSaver } from './lib/noteSaver'

/** `'1'` when collapsed, absent when expanded. Global, deliberately not per project. */
const COLLAPSED_KEY = 'prcli:notesCollapsed'

export function NotesPanel({ project }: { project: ProjectDescriptor | undefined }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  // null is "loading": the textarea is disabled so keystrokes cannot land in a
  // note that is about to be replaced by the fetch result.
  const [text, setText] = useState<string | null>(null)
  const projectId = project?.id

  // One saver for the component's lifetime. Rejections are swallowed for the
  // same reason the skills fetch swallows them: the text is still on screen,
  // and this panel is not where transport faults get reported.
  const saver = useRef(
    createNoteSaver((id, body) => {
      window.prcli.notesWrite(id, body).catch(() => {})
    }),
  ).current

  useEffect(() => {
    if (!projectId) {
      setText(null)
      return
    }
    let cancelled = false
    setText(null)
    window.prcli
      .notesRead(projectId)
      .then((body) => {
        if (!cancelled) setText(body)
      })
      .catch(() => {
        if (!cancelled) setText('')
      })
    return () => {
      cancelled = true
      // Project switch or unmount: the pending edit carries its own project
      // id, so flushing here cannot write it under the incoming project.
      saver.flush()
    }
  }, [projectId, saver])

  const toggle = (): void => {
    setCollapsed((was) => {
      const now = !was
      if (now) localStorage.setItem(COLLAPSED_KEY, '1')
      else localStorage.removeItem(COLLAPSED_KEY)
      return now
    })
  }

  if (collapsed) {
    return (
      <button
        data-testid="notes-toggle"
        onClick={toggle}
        title="Show notes"
        className="w-6 shrink-0 cursor-default border-y-0 border-l border-r-0 border-solid border-border bg-surface py-3 font-mono text-[10px] uppercase tracking-wider text-faint hover:text-fg"
        style={{ writingMode: 'vertical-rl' }}
      >
        Notes
      </button>
    )
  }

  return (
    <div
      data-testid="notes-panel"
      className="flex w-64 shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
    >
      <button
        data-testid="notes-toggle"
        onClick={toggle}
        title="Hide notes"
        className="cursor-default border-none bg-transparent px-2.5 pb-1 pt-3 text-left text-[10px] uppercase tracking-wider text-faint hover:text-fg"
      >
        Notes
      </button>
      {!project ? (
        <p data-testid="notes-empty" className="px-2.5 py-1 text-faint">
          No project selected.
        </p>
      ) : (
        <textarea
          data-testid="notes-textarea"
          // Load-bearing, same as the skills filter: without it ⌘W typed
          // mid-note closes a pane and destroys its tmux session.
          data-shortcuts="off"
          value={text ?? ''}
          disabled={text === null}
          onChange={(event) => {
            const body = event.target.value
            setText(body)
            if (projectId) saver.edit(projectId, body)
          }}
          onBlur={() => saver.flush()}
          placeholder="Notes for this project"
          spellCheck={false}
          className="scroll-thin m-2.5 mt-1 min-h-0 flex-1 resize-none border border-border bg-transparent p-1.5 text-[11px] text-fg select-text placeholder:text-faint focus:outline-none"
        />
      )}
    </div>
  )
}
```

Notes for the implementer:
- `select-text` on the textarea is required because the panel container is `select-none`, which would otherwise inherit into the textarea and block text selection in Chromium.
- The strip and the header share the `notes-toggle` test id on purpose: one button semantic in both states, and the e2e toggle test clicks the same id twice.
- `notes-` never collides with a counted e2e prefix; do not rename these ids to anything starting `tab-` or `skill-`.

- [ ] **Step 2: Render it from App**

In `src/renderer/App.tsx`, add to the import block beside the `RightPanel` import:

```tsx
import { NotesPanel } from './NotesPanel'
```

Then directly after the `{panelOpen ? ( <RightPanel ... /> ) : null}` expression (closing at line 977), as its next sibling in the same flex row:

```tsx
        {/* Deliberately outside the `panelOpen` conditional: the notes column
            and the Skills/Presets column open and close independently. */}
        <NotesPanel project={project} />
```

`project` is the same variable the `RightPanel` invocation two lines above already passes.

- [ ] **Step 3: Typecheck and eyeball**

Run: `npm run typecheck`
Expected: clean.

Then `npm start`, and check by hand: notes column at the right edge, types, collapses to a strip, expands back, survives an app restart collapsed (this manual check is the only place relaunch persistence of the collapse bit is verified; the spec keeps it out of e2e).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/NotesPanel.tsx src/renderer/App.tsx
git commit -m "Render the NOTES column at the right edge, collapsible and per project"
```

---

### Task 5: E2E spec

**Files:**
- Test: `tests/e2e/notes.spec.ts`

**Interfaces:**
- Consumes: test ids from Task 4 (`notes-panel`, `notes-toggle`, `notes-textarea`), sidebar ids `project-id-alpha` / `project-id-beta` (pattern `project-<projectId>`, as in `projects.spec.ts`), `new-tab`, the `tab-` prefix count, and `launchApp` / `killServer` from `tests/e2e/harness.ts`.
- Produces: nothing downstream; final task.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/notes.spec.ts`:

```ts
/**
 * The NOTES column: per-project text that survives a project switch, a
 * collapse toggle, and a ⌘W typed mid-note.
 *
 * A fresh spec file with its own page, so no earlier file's typing makes an
 * assertion here vacuous. Within the file the tests still share one page, so
 * anything that depends on the textarea's contents must set them.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-notes'
const ALPHA_NOTE = 'startup: npm run dev'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-notes-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-notes-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-notes-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-notes-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-notes-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  const betaCwd = join(projectsRoot, 'beta')
  await mkdir(alphaCwd, { recursive: true })
  await mkdir(betaCwd, { recursive: true })

  // Two projects, so a switch is a real one. `slug` is required: `isProject`
  // (src/main/state/store.ts:94) silently drops a row without one.
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [
        { id: 'id-alpha', name: 'alpha', slug: 'alpha', cwd: alphaCwd, presets: [] },
        { id: 'id-beta', name: 'beta', slug: 'beta', cwd: betaCwd, presets: [] },
      ],
      tabs: [],
      activeProjectId: 'id-alpha',
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

test('a note typed under one project survives a switch away and back', async () => {
  const textarea = page.getByTestId('notes-textarea')
  // Enabled is "loaded": the component disables the textarea until the fetch
  // for the active project resolves.
  await expect(textarea).toBeEnabled()
  await textarea.fill(ALPHA_NOTE)

  // The switch is the flush: asserting persistence through it tests the save
  // path without racing the 500ms debounce.
  await page.getByTestId('project-id-beta').click()
  await expect(textarea).toBeEnabled()
  await expect(textarea).toHaveValue('')

  // The flush wrote a real file under the app's config dir, keyed by the id
  // the text was typed under. Polled: the IPC write lands asynchronously.
  await expect
    .poll(() => readFile(join(configDir, 'notes', 'id-alpha.md'), 'utf8').catch(() => null))
    .toBe(ALPHA_NOTE)

  await page.getByTestId('project-id-alpha').click()
  await expect(textarea).toHaveValue(ALPHA_NOTE)
})

test('a note typed under beta does not leak into alpha', async () => {
  // The id-capture race, from the UI side: type under beta, switch to alpha
  // before the debounce fires, and alpha's file must be untouched.
  await page.getByTestId('project-id-beta').click()
  const textarea = page.getByTestId('notes-textarea')
  await expect(textarea).toBeEnabled()
  await expect(textarea).toHaveValue('')
  await textarea.fill('beta only')
  await page.getByTestId('project-id-alpha').click()
  await expect(textarea).toHaveValue(ALPHA_NOTE)
  await expect
    .poll(() => readFile(join(configDir, 'notes', 'id-beta.md'), 'utf8').catch(() => null))
    .toBe('beta only')
  expect(await readFile(join(configDir, 'notes', 'id-alpha.md'), 'utf8')).toBe(ALPHA_NOTE)
})

test('the toggle collapses the panel to a strip and expands it back', async () => {
  await expect(page.getByTestId('notes-textarea')).toBeVisible()
  await page.getByTestId('notes-toggle').click()
  // Collapsed is a strip: the panel and its textarea are gone, the toggle
  // itself is what remains.
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(page.getByTestId('notes-textarea')).toHaveCount(0)
  await page.getByTestId('notes-toggle').click()
  await expect(page.getByTestId('notes-textarea')).toBeVisible()
})

test('⌘W typed into the notes textarea does not destroy a pane', async () => {
  // Same guard as the skills filter, same reason, same shape of test.
  await page.getByTestId('new-tab').click()
  const before = await page.locator('[data-testid^="tab-"]').count()
  expect(before).toBeGreaterThan(0)
  const textarea = page.getByTestId('notes-textarea')
  await textarea.click()
  await textarea.pressSequentially('mid-note ')
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid^="tab-"]').count()).toBe(before)
})
```

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test tests/e2e/notes.spec.ts`
Expected: 4 passing. (If a launch stalls in `firstWindow`, see the AppKit modal note in `harness.ts`; a retry is expected practice, not evidence of a bug here.)

- [ ] **Step 3: Run the full gates**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: all green. The full e2e run is the regression check: this feature adds a sibling to the main flex row, and `splits.spec.ts` / `tabs.spec.ts` assert pane geometry that a layout mistake would move.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/notes.spec.ts
git commit -m "Cover the NOTES column end to end: persistence, id capture, collapse, guarded keys"
```

---

## Self-review (done at planning time)

- Spec coverage: layout/collapse (Task 4), storage (Task 1), IPC (Task 2), renderer flow and id-capture flush (Tasks 3-4), no-project placeholder (Task 4, `notes-empty`; exercised manually since the e2e fixture always has a project), unit and e2e testing (Tasks 1, 3, 5). Relaunch persistence of the collapse bit: manual, Task 4 Step 3, per spec.
- No placeholders: every step carries the code or the exact command.
- Type consistency: `readNote`/`writeNote` names match across Tasks 1-2; `createNoteSaver(write, delayMs)` and `NoteSaver.edit/flush` match across Tasks 3-4; test ids match across Tasks 4-5.
