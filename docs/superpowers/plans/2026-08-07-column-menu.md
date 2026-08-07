# Column visibility in the View menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six checkbox items in the View menu, one per side column, ticked from real state, plus one item that hides every column and restores the set you had.

**Architecture:** Notes gives up its private collapse state so `App.tsx` owns all six flags. A pure module holds the hide-all and restore logic. A fire-and-forget channel carries the six booleans to main, which updates each menu item's `checked` by id rather than rebuilding the menu.

**Tech Stack:** TypeScript, Electron, React 19, vitest (unit, `environment: 'node'`), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-08-07-column-menu-design.md`

## Global Constraints

- **Never use em dashes** anywhere: code, comments, commit messages. Use commas, colons, parentheses or separate sentences. Hyphens in compound words are fine. Verify before each commit with `git diff master..HEAD -- . | grep '^+' | grep $'\u2014'` returning nothing.
- **The app is `pterm`**: IPC channels `pterm:*`, localStorage keys `pterm:*`, the API interface is `PTermApi`.
- **No testid may begin with `tab-`.** Over 27 e2e locators count open tabs by `[data-testid^="tab-"]`.
- **Every new menu item sets `registerAccelerator: false`.** Electron then displays the keystroke without claiming it, and the renderer's own handler (which declines to fire inside `[data-shortcuts="off"]`) implements it. An Electron-registered accelerator would fire while the user is typing in a text field, which this app has shipped as a bug twice.
- **Collapse flags use the existing storage convention:** `'0'` means expanded, anything else including absent means collapsed. Every column defaults to collapsed.
- **Comments explain WHY, not what**, and must never assert something unmeasured.

---

### Task 1: Hide-all and restore, as pure functions

No UI, no menu, no IPC. Just the logic and its tests.

**Files:**
- Create: `src/renderer/lib/columnVisibility.ts`
- Test: `tests/unit/columnVisibility.test.ts`

**Interfaces:**
- Produces:
  - type `ColumnId = 'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git'`
  - type `ColumnVisibility = Record<ColumnId, boolean>` where the value is **collapsed**, matching the existing `*Collapsed` state names
  - `COLUMN_IDS: readonly ColumnId[]` in on-screen order
  - `anyOpen(state: ColumnVisibility): boolean`
  - `hideAll(state: ColumnVisibility): { next: ColumnVisibility; remembered: ColumnId[] }`
  - `restore(state: ColumnVisibility, remembered: ColumnId[]): ColumnVisibility`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/columnVisibility.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  COLUMN_IDS,
  anyOpen,
  hideAll,
  restore,
  type ColumnVisibility,
} from '../../src/renderer/lib/columnVisibility'

/** Every column collapsed, which is what a fresh profile looks like. */
const ALL_SHUT: ColumnVisibility = {
  files: true,
  skills: true,
  presets: true,
  prompts: true,
  notes: true,
  git: true,
}

const withOpen = (...open: Array<keyof ColumnVisibility>): ColumnVisibility => {
  const next = { ...ALL_SHUT }
  for (const id of open) next[id] = false
  return next
}

describe('COLUMN_IDS', () => {
  it('lists the six columns in on-screen order', () => {
    expect(COLUMN_IDS).toEqual(['files', 'skills', 'presets', 'prompts', 'notes', 'git'])
  })
})

describe('anyOpen', () => {
  it('is false when every column is collapsed', () => {
    expect(anyOpen(ALL_SHUT)).toBe(false)
  })

  it('is true when one column is open', () => {
    expect(anyOpen(withOpen('git'))).toBe(true)
  })
})

describe('hideAll', () => {
  it('closes everything and remembers what was open', () => {
    const { next, remembered } = hideAll(withOpen('files', 'git'))
    expect(next).toEqual(ALL_SHUT)
    expect(remembered).toEqual(['files', 'git'])
  })

  it('remembers in on-screen order, not the order they were opened', () => {
    const { remembered } = hideAll(withOpen('git', 'files'))
    expect(remembered).toEqual(['files', 'git'])
  })

  it('remembers a single open column', () => {
    expect(hideAll(withOpen('notes')).remembered).toEqual(['notes'])
  })

  it('remembers nothing when nothing was open', () => {
    const { next, remembered } = hideAll(ALL_SHUT)
    expect(remembered).toEqual([])
    expect(next).toEqual(ALL_SHUT)
  })
})

describe('restore', () => {
  it('reopens exactly the remembered set and nothing else', () => {
    expect(restore(ALL_SHUT, ['files', 'git'])).toEqual(withOpen('files', 'git'))
  })

  // The fresh-profile case: pressing the item with nothing open and nothing
  // remembered must not invent a default.
  it('changes nothing when nothing is remembered', () => {
    expect(restore(ALL_SHUT, [])).toEqual(ALL_SHUT)
  })

  it('leaves an already-open column open', () => {
    expect(restore(withOpen('notes'), ['notes'])).toEqual(withOpen('notes'))
  })
})

describe('the round trip', () => {
  it('returns the exact starting state', () => {
    const start = withOpen('skills', 'prompts', 'notes')
    const { next, remembered } = hideAll(start)
    expect(restore(next, remembered)).toEqual(start)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/columnVisibility.test.ts`
Expected: FAIL, cannot resolve `../../src/renderer/lib/columnVisibility`

- [ ] **Step 3: Write the implementation**

Create `src/renderer/lib/columnVisibility.ts`:

```ts
/**
 * Which side columns are collapsed, and the two operations the View menu's
 * hide-all item needs.
 *
 * The booleans are COLLAPSED rather than visible, matching the `*Collapsed`
 * state that `App.tsx` already holds and the `'0' means expanded` convention
 * the stored keys already use. Inverting the sense here would mean one file
 * disagreeing with five call sites about what `true` means.
 *
 * Pure and framework-free for the reason `mutationGuard.ts` and
 * `diffLines.ts` are: this repo's vitest runs `environment: 'node'` with no
 * DOM, so logic that lives inside a component cannot be unit-tested at all.
 */
export type ColumnId = 'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git'

export type ColumnVisibility = Record<ColumnId, boolean>

/** Left to right as they appear on screen, which is the order the menu lists. */
export const COLUMN_IDS: readonly ColumnId[] = [
  'files',
  'skills',
  'presets',
  'prompts',
  'notes',
  'git',
]

export function anyOpen(state: ColumnVisibility): boolean {
  return COLUMN_IDS.some((id) => !state[id])
}

/**
 * Close every column, and report which were open so `restore` can put exactly
 * those back.
 *
 * The remembered list is built by walking `COLUMN_IDS`, so it is always in
 * on-screen order regardless of the order the user opened things in. Nothing
 * depends on that order today; it is done so that a remembered set compares
 * equal to itself across a round trip, which is what the test asserts.
 */
export function hideAll(state: ColumnVisibility): {
  next: ColumnVisibility
  remembered: ColumnId[]
} {
  const remembered = COLUMN_IDS.filter((id) => !state[id])
  const next = { ...state }
  for (const id of COLUMN_IDS) next[id] = true
  return { next, remembered }
}

/**
 * Reopen exactly `remembered`, leaving every other column as it is.
 *
 * An empty `remembered` changes nothing. That is the fresh-profile case, where
 * every column starts collapsed and there is no previous set: opening some
 * default there would take terminal width the user never asked for, which is
 * the rule every column in this app already follows.
 */
export function restore(state: ColumnVisibility, remembered: ColumnId[]): ColumnVisibility {
  const next = { ...state }
  for (const id of remembered) next[id] = false
  return next
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/columnVisibility.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/renderer/lib/columnVisibility.ts tests/unit/columnVisibility.test.ts
git commit -m "Decide which columns a hide-all closes, and which a restore reopens"
```

---

### Task 2: Lift Notes' collapse state into App.tsx

Nothing user-visible changes. Notes keeps behaving exactly as it does now, but its state moves so the rest of the feature can reach it.

**Files:**
- Modify: `src/renderer/NotesPanel.tsx`, `src/renderer/App.tsx`
- Test: `tests/e2e/notes.spec.ts` (existing, must stay green)

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `NotesPanel` now takes `{ project, collapsed, onToggle }`; `App.tsx` owns `NOTES_KEY = 'pterm:notesCollapsed'`, `notesCollapsed` state and `toggleNotes`

- [ ] **Step 1: Change NotesPanel's signature**

In `src/renderer/NotesPanel.tsx`, delete the `COLLAPSED_KEY` const, the `collapsed` `useState`, and the local `toggle` function. Take them as props instead:

```tsx
export function NotesPanel({
  project,
  collapsed,
  onToggle,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
}) {
```

Replace both uses of the local `toggle` with `onToggle`. The two are `PanelStrip`'s `onClick` when collapsed and `PanelHeading`'s `onClick` when expanded. Read the file to find them rather than assuming; do not change anything else in it.

- [ ] **Step 2: Own the state in App.tsx**

Add the key beside the other five (they sit together around `GIT_KEY`):

```ts
const NOTES_KEY = 'pterm:notesCollapsed'
```

Add the state beside `gitCollapsed`:

```ts
  const [notesCollapsed, setNotesCollapsed] = useState(() => storedCollapsed(NOTES_KEY, true))
```

Add the toggle beside `togglePresets`, following the identical shape the other five use:

```ts
  const toggleNotes = useCallback(() => {
    setNotesCollapsed((was) => {
      localStorage.setItem(NOTES_KEY, was ? '0' : '1')
      return !was
    })
  }, [])
```

Pass them at the call site, which currently reads `<NotesPanel project={project} />`:

```tsx
        <NotesPanel project={project} collapsed={notesCollapsed} onToggle={toggleNotes} />
```

- [ ] **Step 3: Correct the comment that is now wrong**

The doc comment above `SKILLS_KEY` says "Collapse state for the five collapsible columns" and "five of them plus the sidebar leave under 40px of terminal". There are six now. Update both numbers, and recompute the arithmetic honestly rather than scaling the old figure: six columns at 208px plus the 208px sidebar is 1456px, which already exceeds the 1280px window, so the honest statement is that six open columns do not fit at all.

The comment also says the shape matches "the same shape `NotesPanel` stores its own", which is no longer true of where the state lives. Reword so it describes the convention rather than pointing at `NotesPanel`.

- [ ] **Step 4: Verify Notes still behaves identically**

Run: `npx playwright test tests/e2e/notes.spec.ts`
Expected: PASS, unchanged. This spec exercises expanding, collapsing and persistence across a relaunch, so it is the regression net for the lift.

- [ ] **Step 5: Full gates**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/NotesPanel.tsx src/renderer/App.tsx
git commit -m "Move Notes' collapse state where the other five columns keep theirs"
```

---

### Task 3: The six checkbox items, and the keystrokes

The menu items exist and work. They do not yet show state; Task 4 does that.

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`, `src/renderer/App.tsx`
- Test: `tests/e2e/menuColumns.spec.ts`

**Interfaces:**
- Consumes: `toggleNotes` from Task 2; all six toggles in `App.tsx`
- Produces: `MenuCommand` gains `'toggleFiles' | 'toggleSkills' | 'togglePrompts' | 'toggleNotes' | 'toggleGit' | 'hideAllColumns'`; menu item ids `toggle-files`, `toggle-skills`, `toggle-presets`, `toggle-prompts`, `toggle-notes`, `toggle-git`, `hide-all-columns`

- [ ] **Step 1: Widen the command union**

In `src/shared/ipc.ts`, the `MenuCommand` union currently ends `| 'togglePresets' | 'settings'`. Add the five new toggles and the hide-all:

```ts
export type MenuCommand =
  | 'newTab'
  | 'closePane'
  | 'splitRight'
  | 'splitDown'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'toggleFiles'
  | 'toggleSkills'
  | 'togglePresets'
  | 'togglePrompts'
  | 'toggleNotes'
  | 'toggleGit'
  | 'hideAllColumns'
  | 'settings'
```

- [ ] **Step 2: Replace the View menu's first entry**

In `src/main/index.ts`, the View submenu currently opens with the single `toggle-presets` item followed by a separator. Replace that item with six, keeping the separator, and add the hide-all with its own separator after it:

```ts
        {
          id: 'toggle-files',
          label: 'Files',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+F',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleFiles'),
        },
        {
          id: 'toggle-skills',
          label: 'Skills',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+S',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleSkills'),
        },
        {
          id: 'toggle-presets',
          label: 'Presets',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+P',
          registerAccelerator: false,
          click: () => sendMenuCommand('togglePresets'),
        },
        {
          id: 'toggle-prompts',
          label: 'Prompts',
          type: 'checkbox',
          // One modifier away from `reload`'s CmdOrCtrl+R, and distinct from
          // it. Taken so the six letters stay mnemonic: P is spent on Presets,
          // and one non-mnemonic key among six is harder to remember than a
          // near miss.
          accelerator: 'Alt+CmdOrCtrl+R',
          registerAccelerator: false,
          click: () => sendMenuCommand('togglePrompts'),
        },
        {
          id: 'toggle-notes',
          label: 'Notes',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+N',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleNotes'),
        },
        {
          id: 'toggle-git',
          label: 'Git',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+G',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleGit'),
        },
        { type: 'separator' },
        {
          id: 'hide-all-columns',
          // Relabelled from main whenever the renderer reports its columns,
          // so it never claims to do the opposite of what it will do.
          label: 'Hide All Columns',
          accelerator: 'Shift+CmdOrCtrl+\\',
          registerAccelerator: false,
          click: () => sendMenuCommand('hideAllColumns'),
        },
        { type: 'separator' },
```

Note `toggle-presets` keeps its id and its command name but loses `Shift+CmdOrCtrl+\` to the hide-all item, and its label becomes `Presets` rather than `Toggle Presets`.

- [ ] **Step 3: Handle the commands in the renderer**

In `src/renderer/App.tsx`'s `onMenuCommand` switch, the existing `togglePresets` case currently calls `toggleSidePanels`. Point it at the single-column toggle and add the rest:

```ts
          case 'toggleFiles':
            toggleFiles()
            return
          case 'toggleSkills':
            toggleSkills()
            return
          case 'togglePresets':
            togglePresets()
            return
          case 'togglePrompts':
            togglePrompts()
            return
          case 'toggleNotes':
            toggleNotes()
            return
          case 'toggleGit':
            toggleGit()
            return
          case 'hideAllColumns':
            hideAllColumns()
            return
```

Read the switch first: it is inside an effect, and every callback it names must already be in that effect's dependency array or the switch will close over a stale one. Add the new callbacks there too.

- [ ] **Step 4: Implement `hideAllColumns` and the keystrokes**

In `App.tsx`, using Task 1's module. `toggleSidePanels` is replaced entirely, along with the `Backslash` branch in the keydown handler that called it.

```tsx
import {
  COLUMN_IDS,
  anyOpen,
  hideAll,
  restore,
  type ColumnId,
  type ColumnVisibility,
} from './lib/columnVisibility'
```

```tsx
  // What was open when hide-all last closed everything. A ref, not state:
  // nothing renders from it, and it must not be persisted, because it answers
  // "what did I have open a moment ago" and a set restored from last week is
  // not that.
  const rememberedColumns = useRef<ColumnId[]>([])

  const columns: ColumnVisibility = {
    files: filesCollapsed,
    skills: skillsCollapsed,
    presets: presetsCollapsed,
    prompts: promptsCollapsed,
    notes: notesCollapsed,
    git: gitCollapsed,
  }

  const setColumn: Record<ColumnId, (collapsed: boolean) => void> = {
    files: setFilesCollapsed,
    skills: setSkillsCollapsed,
    presets: setPresetsCollapsed,
    prompts: setPromptsCollapsed,
    notes: setNotesCollapsed,
    git: setGitCollapsed,
  }

  const COLUMN_KEY: Record<ColumnId, string> = {
    files: FILES_KEY,
    skills: SKILLS_KEY,
    presets: PRESETS_KEY,
    prompts: PROMPTS_KEY,
    notes: NOTES_KEY,
    git: GIT_KEY,
  }

  /**
   * Close every column, or reopen the set the last close remembered.
   *
   * Which of the two it does is decided by whether anything is open, so the
   * one item and the one keystroke cover both directions.
   */
  const hideAllColumns = useCallback(() => {
    const now: ColumnVisibility = {
      files: filesCollapsed,
      skills: skillsCollapsed,
      presets: presetsCollapsed,
      prompts: promptsCollapsed,
      notes: notesCollapsed,
      git: gitCollapsed,
    }
    const next = anyOpen(now)
      ? (() => {
          const closed = hideAll(now)
          rememberedColumns.current = closed.remembered
          return closed.next
        })()
      : restore(now, rememberedColumns.current)
    for (const id of COLUMN_IDS) {
      setColumn[id](next[id])
      localStorage.setItem(COLUMN_KEY[id], next[id] ? '1' : '0')
    }
  }, [filesCollapsed, skillsCollapsed, presetsCollapsed, promptsCollapsed, notesCollapsed, gitCollapsed])
```

In the keydown handler, replace the `Backslash` branch (which currently calls `toggleSidePanels`) with a call to `hideAllColumns`, and add the six letter bindings. Every one of them must sit AFTER the handler's existing `data-shortcuts="off"` guard and its `if (!event.metaKey) return`, and must test `event.code` with `event.altKey`, matching how the arrow bindings already do it:

```ts
      if (event.altKey && !event.shiftKey) {
        const column: Record<string, () => void> = {
          KeyF: toggleFiles,
          KeyS: toggleSkills,
          KeyP: togglePresets,
          KeyR: togglePrompts,
          KeyN: toggleNotes,
          KeyG: toggleGit,
        }
        const toggle = column[event.code]
        if (toggle) {
          event.preventDefault()
          toggle()
          return
        }
      }
```

Read the handler before inserting: the existing `⌥⌘` arrow branch also tests `event.altKey && !event.shiftKey`, so place this beside it rather than nesting inside it, and make sure the arrow branch still returns for arrow codes.

- [ ] **Step 5: Write the e2e test**

Create `tests/e2e/menuColumns.spec.ts`. Trigger items through the main process, since Playwright cannot drive the macOS menu bar. Model the fixture on `tests/e2e/notes.spec.ts`'s launch and seeding.

```ts
/**
 * The View menu's column items. Driven through the main process, because
 * Playwright cannot reach the macOS menu bar.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let page: Page

/** Fire a menu item by id, the way a click on the real menu bar would. */
async function clickMenuItem(id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click()
  }, id)
}

/** Whether a checkbox menu item is currently ticked. */
async function isChecked(id: string): Promise<boolean> {
  return app.evaluate(({ Menu }, itemId) => {
    return Menu.getApplicationMenu()?.getMenuItemById(itemId)?.checked ?? false
  }, id)
}

/** A menu item's current label. */
async function labelOf(id: string): Promise<string> {
  return app.evaluate(({ Menu }, itemId) => {
    return Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label ?? ''
  }, id)
}

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-root-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-proj-menu-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-claude-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-menu', name: 'Menu', slug: 'menu', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-menu',
      tabs: [],
    }),
    'utf8',
  )
  app = await launchApp({ socket: SOCKET, configDir, projectsRoot,
    claudeSettings: claudeSettingsPath, claudeHome, userDataDir })
  page = await app.firstWindow()
  await expect(page.getByTestId('git-toggle')).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a column item opens and closes its column', async () => {
  await expect(page.getByTestId('git-panel')).toHaveCount(0)

  await clickMenuItem('toggle-git')
  await expect(page.getByTestId('git-panel')).toBeVisible()

  await clickMenuItem('toggle-git')
  await expect(page.getByTestId('git-panel')).toHaveCount(0)
})

test('hide all closes every open column, and a second press restores exactly them', async () => {
  await clickMenuItem('toggle-git')
  await clickMenuItem('toggle-notes')
  await expect(page.getByTestId('git-panel')).toBeVisible()
  await expect(page.getByTestId('notes-panel')).toBeVisible()

  await clickMenuItem('hide-all-columns')
  await expect(page.getByTestId('git-panel')).toHaveCount(0)
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)

  await clickMenuItem('hide-all-columns')
  await expect(page.getByTestId('git-panel')).toBeVisible()
  await expect(page.getByTestId('notes-panel')).toBeVisible()
  // Exactly those two, not a default set.
  await expect(page.getByTestId('files-panel')).toHaveCount(0)
  await expect(page.getByTestId('skills-panel')).toHaveCount(0)
})
```

Leave `isChecked` and `labelOf` defined but unused for now; Task 4 adds the
tests that call them. If your linter rejects unused functions, add them in
Task 4 instead and say so.

- [ ] **Step 6: Run it**

Run: `npx playwright test tests/e2e/menuColumns.spec.ts`
Expected: PASS, 2 tests. Both assert on the column itself, which works without
the menu sync Task 4 adds.

- [ ] **Step 7: Full gates**

Run: `npm run typecheck && npm test`

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/main/index.ts src/renderer/App.tsx tests/e2e/menuColumns.spec.ts
git commit -m "Put a menu item and a keystroke on each column, and one on all of them"
```

---

### Task 4: Sync the state up so the ticks are real

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/App.tsx`
- Test: `tests/e2e/menuColumns.spec.ts` (the two tests Task 3 left failing)

**Interfaces:**
- Consumes: `ColumnVisibility`, `COLUMN_IDS`, `anyOpen` from Task 1; the menu item ids from Task 3
- Produces: channel `pterm:columnsVisible`; `PTermApi.columnsVisible(state: Record<string, boolean>): void`

- [ ] **Step 1: Add the channel**

`src/shared/ipc.ts`, in `CHANNELS`:

```ts
  columnsVisible: 'pterm:columnsVisible',
```

In `PTermApi`, beside the other `void` senders:

```ts
  /**
   * Tell main which side columns are collapsed, so the View menu's checkboxes
   * and its hide-all label can show the truth.
   *
   * Fire and forget, like `setActive`: main holds this only for display, and
   * the renderer stays the source of truth. A dropped message costs a stale
   * tick until the next change, never a wrong toggle, because every menu
   * command still asks the renderer to flip its own state.
   */
  columnsVisible(collapsed: Record<string, boolean>): void
```

`src/preload/index.ts`, beside `setActive`:

```ts
  columnsVisible: (collapsed) => ipcRenderer.send(CHANNELS.columnsVisible, collapsed),
```

- [ ] **Step 2: Receive it in main and update the items**

In `src/main/index.ts`. The menu items are looked up by id and mutated, rather than the menu being rebuilt, so the template stays the single definition of the menu's shape.

```ts
/**
 * Show the renderer's column state on the View menu.
 *
 * By id rather than by rebuilding the template: a rebuild would re-create
 * every item on every column toggle, and the ids already exist for the tests
 * to click through.
 */
function showColumns(collapsed: Record<string, boolean>): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const ids: Record<string, string> = {
    files: 'toggle-files',
    skills: 'toggle-skills',
    presets: 'toggle-presets',
    prompts: 'toggle-prompts',
    notes: 'toggle-notes',
    git: 'toggle-git',
  }
  let open = false
  for (const [column, itemId] of Object.entries(ids)) {
    const shut = collapsed[column] === true
    if (!shut) open = true
    const item = menu.getMenuItemById(itemId)
    if (item) item.checked = !shut
  }
  const all = menu.getMenuItemById('hide-all-columns')
  if (all) all.label = open ? 'Hide All Columns' : 'Show All Columns'
}
```

Register it where the other `ipcMain.on` listeners live. If `src/main/index.ts` has no `ipcMain` import yet, add it; the menu is built there and this listener belongs beside it rather than in `register.ts`, which owns workspace channels rather than chrome.

```ts
  ipcMain.on(CHANNELS.columnsVisible, (_event, collapsed: Record<string, boolean>) => {
    showColumns(collapsed)
  })
```

- [ ] **Step 3: Send it from the renderer**

In `App.tsx`, one effect that fires on mount and on every change:

```tsx
  // Main cannot read localStorage or React state, so the menu's checkmarks
  // would otherwise be a guess. Sent on mount too, not only on change: a
  // relaunch restores these from localStorage without any toggle firing.
  useEffect(() => {
    window.pterm.columnsVisible({
      files: filesCollapsed,
      skills: skillsCollapsed,
      presets: presetsCollapsed,
      prompts: promptsCollapsed,
      notes: notesCollapsed,
      git: gitCollapsed,
    })
  }, [filesCollapsed, skillsCollapsed, presetsCollapsed, promptsCollapsed, notesCollapsed, gitCollapsed])
```

- [ ] **Step 4: Add the two tests that need the sync**

These are the ones a renderer-only test cannot cover, because they assert on
state travelling UP to the menu. Append to `tests/e2e/menuColumns.spec.ts`:

```ts
// Without the sync this fails while the column itself works fine, which is
// exactly the gap Task 3 could not close on its own.
test('opening a column by its strip ticks the menu item', async () => {
  expect(await isChecked('toggle-git')).toBe(false)

  await page.getByTestId('git-toggle').click()
  await expect(page.getByTestId('git-panel')).toBeVisible()

  await expect.poll(() => isChecked('toggle-git'), { timeout: 10_000 }).toBe(true)
})

test('the hide-all item renames itself once everything is hidden', async () => {
  await clickMenuItem('toggle-git')
  await expect.poll(() => labelOf('hide-all-columns'), { timeout: 10_000 }).toBe('Hide All Columns')

  await clickMenuItem('hide-all-columns')
  await expect.poll(() => labelOf('hide-all-columns'), { timeout: 10_000 }).toBe('Show All Columns')
})
```

Verify each catches the regression it is named for: comment out the
`ipcMain.on(CHANNELS.columnsVisible, ...)` listener from Step 2, re-run these
two, and watch both go red. Restore it and re-run. Report that output.

- [ ] **Step 5: Run the whole file**

Run: `npx playwright test tests/e2e/menuColumns.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the accelerators do not fire in a text field**

This is the constraint the whole `registerAccelerator: false` decision exists for, and no test above covers it. Add to `tests/e2e/menuColumns.spec.ts`:

```ts
// The reason every item sets `registerAccelerator: false`. An
// Electron-registered accelerator fires everywhere, including while the user
// is typing, which this app has shipped as a bug twice.
test('a column shortcut typed into a text field does not toggle the column', async () => {
  await clickMenuItem('toggle-notes')
  await expect(page.getByTestId('notes-panel')).toBeVisible()

  await page.getByTestId('notes-textarea').click()
  await page.keyboard.press('Alt+Meta+G')
  await page.waitForTimeout(500)

  await expect(page.getByTestId('git-panel')).toHaveCount(0)
})
```

Check the notes textarea's real testid before using it, and confirm it carries `data-shortcuts="off"`. If it does not, that is a finding to report rather than to work around: say so, and use a text field that does.

- [ ] **Step 6: Full gates**

Run: `npm run typecheck && npm test && npx playwright test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/index.ts src/renderer/App.tsx tests/e2e/menuColumns.spec.ts
git commit -m "Show the real column state on the View menu"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the six checkbox items and their accelerators (Task 3), `registerAccelerator: false` and the renderer handling the keystrokes (Task 3 Step 4, tested in Task 4 Step 5), the state channel and the by-id update (Task 4), the dynamic hide-all label (Task 4 Step 2, tested in Task 3's fourth test), lifting Notes (Task 2), hide-all semantics including the no-op case (Task 1), and the `MenuCommand` additions (Task 3 Step 1).

**Placeholder scan.** Clean. Every step carries the code it needs. Three steps deliberately say "read the file first" rather than quoting a line range: Task 2 Step 1 (`NotesPanel`'s two `toggle` call sites), Task 3 Step 3 (the switch's dependency array) and Task 3 Step 4 (where the `⌥⌘` arrow branch sits). Those are places where a stale line number would be worse than an instruction to look, since `App.tsx` moves under edits.

**Type consistency.** `ColumnId`, `ColumnVisibility`, `COLUMN_IDS`, `anyOpen`, `hideAll` and `restore` are defined in Task 1 and used unchanged in Tasks 3 and 4. The menu item ids are fixed in Task 3 Step 2 and reused verbatim in Task 4 Step 2 and in the tests. The booleans mean COLLAPSED everywhere, including over the wire, matching the existing `*Collapsed` state names.

**One risk worth naming.**

1. `⌥⌘S` must not reach the existing `⌘S` save binding. The handler already excludes `altKey` on that branch, so it should not, but the six-letter map in Task 3 Step 4 sits in the same handler and a misplaced insertion could shadow it. Running `tests/e2e/editor.spec.ts` after Task 3 is the cheap check, since that spec exercises saving.
