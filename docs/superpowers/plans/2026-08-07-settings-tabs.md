# Settings Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four stacked sections of `src/renderer/SettingsPane.tsx` with four line tabs, one file per section, and move the app version into a footer.

**Architecture:** A thin shell (`settings/SettingsPane.tsx`) owns the Dialog, the active tab and the version footer. A hand-rolled strip (`settings/SettingsTabs.tsx`) renders `role="tab"` buttons over a pure tab list (`settings/tabs.ts`). Each of the four sections is its own file owning its own IPC reads, error state and busy flag; inactive tabs are unmounted, so a section fetches when you select its tab.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (`@theme` tokens in `src/renderer/index.css`), Radix Dialog (the only Radix package installed), Vitest (node environment), Playwright Electron.

**Spec:** `docs/superpowers/specs/2026-08-07-settings-tabs-design.md`

## Global Constraints

- **No em dashes anywhere**, in code, comments, copy or commit messages. Verify with `grep -rn $'\u2014' <changed files>` before each commit.
- **No new dependencies.** `@radix-ui/react-tabs` is not installed and is not being added. Only `@radix-ui/react-dialog` exists.
- **Unit tests run in the node environment** (`vitest.config.ts` sets `environment: 'node'`). There is no jsdom and no testing-library, so no component may be unit tested by rendering it. Component behaviour is proved by Playwright only.
- **Every e2e spec must launch through `launchApp` in `tests/e2e/harness.ts`.** `tests/unit/e2eSafety.test.ts` enumerates every `.ts` file under `tests/e2e/` and fails if any of them calls `electron.launch` directly.
- **Every e2e spec needs its own tmux socket name.** Existing ones: `pterm-e2e-settingsupdate`, and one per spec file elsewhere.
- **Copy does not change.** Every user-visible string that ships today ships after this plan, byte for byte. `tests/e2e/shellHistorySettings.spec.ts` asserts the shell-history disclosure paragraph fact by fact.
- Commands: `npm test` (vitest), `npm run typecheck` (tsc), `npx playwright test <file>` for one e2e spec.

---

### Task 1: The tab list and arrow-key arithmetic

A pure module, so the one piece of logic in the strip that can be unit tested in a node environment is unit tested rather than left to Playwright.

**Files:**
- Create: `src/renderer/settings/tabs.ts`
- Test: `tests/unit/settingsTabs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SETTINGS_TABS` (a readonly array of `{ id, label }`), `type SettingsTabId = 'notifications' | 'hooks' | 'shell-history' | 'updates'`, and `nextTabIndex(index: number, key: string, count: number): number`. Tasks 2 and 3 import all three.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/settingsTabs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SETTINGS_TABS, nextTabIndex } from '../../src/renderer/settings/tabs'

describe('SETTINGS_TABS', () => {
  // The order is a decision, not an accident: Notifications is first because
  // it is the only tab a user changes more than once, and the settings pane
  // opens on the first tab. Task 3's e2e spec presses ArrowRight from
  // Notifications and expects Hooks, which is this order.
  it('runs Notifications, Hooks, Shell history, Updates', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      'notifications',
      'hooks',
      'shell-history',
      'updates',
    ])
  })

  // The ids become `data-testid="settings-tab-<id>"` and the `aria-controls`
  // of the panel, so a duplicate would give two elements one name and make
  // Playwright's strict-mode locator fail on whichever spec got there first.
  it('gives every tab a distinct id and a label', () => {
    expect(new Set(SETTINGS_TABS.map((tab) => tab.id)).size).toBe(SETTINGS_TABS.length)
    for (const tab of SETTINGS_TABS) expect(tab.label.length).toBeGreaterThan(0)
  })
})

describe('nextTabIndex', () => {
  it('moves right', () => {
    expect(nextTabIndex(0, 'ArrowRight', 4)).toBe(1)
  })

  it('moves left', () => {
    expect(nextTabIndex(2, 'ArrowLeft', 4)).toBe(1)
  })

  // Wrapping at both ends, because a roving tablist that stops dead at the
  // last tab reads as broken to anyone who navigates by keyboard.
  it('wraps past the last tab to the first', () => {
    expect(nextTabIndex(3, 'ArrowRight', 4)).toBe(0)
  })

  it('wraps before the first tab to the last', () => {
    expect(nextTabIndex(0, 'ArrowLeft', 4)).toBe(3)
  })

  // The caller passes every keydown it receives, so anything that is not an
  // arrow has to be a no-op rather than a move. Index 2 rather than 0: with
  // an index of 0, a buggy implementation that always returned 0 would pass.
  it('returns the same index for any other key', () => {
    expect(nextTabIndex(2, 'Enter', 4)).toBe(2)
    expect(nextTabIndex(2, 'a', 4)).toBe(2)
    expect(nextTabIndex(2, 'ArrowDown', 4)).toBe(2)
  })

  // Guards the modulo: `% 0` is NaN, which would put NaN into a tabIndex.
  it('returns the same index when there are no tabs', () => {
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- settingsTabs`
Expected: FAIL, cannot resolve `../../src/renderer/settings/tabs`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/settings/tabs.ts`:

```ts
/**
 * The settings tabs, in the order the strip draws them. Notifications leads
 * because it is the only one of the four a user changes more than once; the
 * other three are one-time installs and a button you press when you wonder.
 * The pane opens on the first entry.
 */
export const SETTINGS_TABS = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'shell-history', label: 'Shell history' },
  { id: 'updates', label: 'Updates' },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

/**
 * Where ArrowLeft and ArrowRight move from `index`, wrapping at both ends.
 * Any other key returns `index` unchanged, so the caller can hand this every
 * keydown and treat "no move" as "not mine".
 *
 * A separate function from the component because this is the only part of the
 * strip a unit test can reach: `vitest.config.ts` runs in the node
 * environment, with no DOM to render a button into.
 */
export function nextTabIndex(index: number, key: string, count: number): number {
  if (count <= 0) return index
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  return index
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- settingsTabs && npm run typecheck`
Expected: 7 tests pass, tsc silent.

- [ ] **Step 5: Commit**

```bash
grep -rn $'\u2014' src/renderer/settings/tabs.ts tests/unit/settingsTabs.test.ts   # expect no output
git add src/renderer/settings/tabs.ts tests/unit/settingsTabs.test.ts
git commit -m "Add the settings tab list and its arrow-key arithmetic"
```

---

### Task 2: Split the four sections into their own files

A pure move. The dialog still stacks all four sections in the same order it does today, so every existing e2e spec passes **unchanged**. That is the gate: if a spec needs editing in this task, something was not a move.

**Files:**
- Create: `src/renderer/settings/errorMessage.ts`
- Create: `src/renderer/settings/HooksSection.tsx`
- Create: `src/renderer/settings/ShellHistorySection.tsx`
- Create: `src/renderer/settings/NotificationsSection.tsx`
- Create: `src/renderer/settings/UpdatesSection.tsx`
- Modify: `src/renderer/SettingsPane.tsx` (becomes a shell that renders the four)
- Test: no new tests. `tests/e2e/status.spec.ts`, `tests/e2e/shellHistorySettings.spec.ts` and `tests/e2e/settingsUpdate.spec.ts` are the regression gate and must not be edited.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `errorMessage(reason: unknown): string`; `HooksSection()`, `ShellHistorySection()` and `UpdatesSection()`, all taking no props; `NotificationsSection({ notifications, onNotificationsChange }: { notifications: NotificationConfig | null; onNotificationsChange: (config: NotificationConfig) => void })`. Task 3 mounts all four.

**How to move the JSX.** Every section's markup, copy and comments move verbatim from the current file. Do not retype them: the shell-history disclosure paragraph is asserted fact by fact by `shellHistorySettings.spec.ts`, and the comments above it record why each sentence exists. Line numbers below are of `SettingsPane.tsx` at the parent commit; read them with `git show HEAD:src/renderer/SettingsPane.tsx | sed -n 'A,Bp'` if the working copy has moved.

| Section | JSX to move | State and functions that move with it |
|---|---|---|
| Hooks | 182-238 | `hooks`, `hooksError`, `busy`, the hooks half of the `[open]` effect, `runHooksAction` |
| Shell history | 240-329 | `shellHistory`, `shellHistoryError`, `shellBusy`, the shell half of the `[open]` effect, `runShellHistoryAction` |
| Notifications | 331-417 | `notifError`, `updateRule`, `toggleMuteWhenFocused`, the `STATES` and `SOUNDS` constants |
| Updates | 419-485 | `updateResult`, `checking`, `skippedVersion`, `refreshSkipped`, the `[open]` skip effect |

`version` and its effect stay in the shell in this task and move to the footer in Task 3.

- [ ] **Step 1: Create the shared error helper**

Create `src/renderer/settings/errorMessage.ts`:

```ts
/**
 * The message to show for a rejected IPC call. Three sections need it and
 * each keeps its own error state, so it lives beside them rather than inside
 * any one of them.
 */
export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
```

- [ ] **Step 2: Create `HooksSection.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { HooksState } from '../../shared/ipc'
import { Button } from '../ui/Button'
import { errorMessage } from './errorMessage'

export function HooksSection() {
  const [hooks, setHooks] = useState<HooksState | null>(null)
  // Its own error, separate from the workspace-wide one: a settings file that
  // does not parse must say so here, in place of an Install button that is
  // certain to fail the moment it is pressed, rather than as a banner over
  // the whole app.
  const [hooksError, setHooksError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Read on mount, which is when this tab is selected: another pTerm window,
  // or a hand edit of settings.json, could have changed the file since it was
  // last read. This used to be an effect keyed on the dialog's `open`, back
  // when all four sections were mounted together.
  useEffect(() => {
    let cancelled = false
    window.pterm
      .hooksState()
      .then((state) => {
        if (!cancelled) setHooks(state)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setHooks(null)
          setHooksError(errorMessage(reason))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runHooksAction = (action: () => Promise<HooksState>): void => {
    setBusy(true)
    action()
      .then((state) => {
        setHooks(state)
        setHooksError(null)
      })
      .catch((reason: unknown) => setHooksError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="mb-4 border-b border-border pb-3">
      {/* lines 183-237 of the old SettingsPane.tsx, verbatim */}
    </section>
  )
}
```

- [ ] **Step 3: Create `ShellHistorySection.tsx`**

Same shape as Step 2. Imports: `import type { ShellHistoryState } from '../../shared/ipc'`, `Button`, `errorMessage`. State: `shellHistory`, `shellHistoryError`, `shellBusy`. One mount effect calling `window.pterm.shellHistoryState()` with the same `cancelled` flag and the same catch. `runShellHistoryAction` moves across unchanged from lines 133-142. The returned `<section className="mb-4 border-b border-border pb-3">` wraps lines 241-328 verbatim, including every comment block: the "Required copy" one, the long consent one, and the disclosure paragraph they describe.

- [ ] **Step 4: Create `NotificationsSection.tsx`**

```tsx
import { useState } from 'react'
import type { NotificationConfig, Rule, TabState } from '../../shared/ipc'
import { globalRuleOf, setGlobalRule } from '../globalRule'
import { StatusDot } from '../StatusDot'
import { errorMessage } from './errorMessage'

const STATES: TabState[] = ['waiting', 'crashed', 'idle', 'thinking', 'running', 'ended']
const SOUNDS = ['', 'Funk', 'Glass', 'Basso', 'Ping', 'Submarine']

export function NotificationsSection({
  notifications,
  onNotificationsChange,
}: {
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
}) {
  // Its own error, separate from the other sections': a failed notification
  // write must say so rather than leaving an unhandled rejection and a
  // checkbox that silently reverts the next time this pane opens.
  const [notifError, setNotifError] = useState<string | null>(null)

  const updateRule = (state: TabState, patch: Partial<Rule>): void => {
    if (!notifications) return
    const rules = setGlobalRule(notifications.rules, state, patch)
    window.pterm
      .updateNotifications({ rules })
      .then((config) => {
        setNotifError(null)
        onNotificationsChange(config)
      })
      .catch((reason: unknown) => setNotifError(errorMessage(reason)))
  }

  const toggleMuteWhenFocused = (): void => {
    if (!notifications) return
    window.pterm
      .updateNotifications({ muteWhenFocused: !notifications.muteWhenFocused })
      .then((config) => {
        setNotifError(null)
        onNotificationsChange(config)
      })
      .catch((reason: unknown) => setNotifError(errorMessage(reason)))
  }

  return (
    <section>
      {/* lines 332-416 of the old SettingsPane.tsx, verbatim */}
    </section>
  )
}
```

- [ ] **Step 5: Create `UpdatesSection.tsx`**

Same shape. Imports: `import type { UpdateCheckResult } from '../../shared/ipc'`, `Button`, `errorMessage`, `import { updateResultText } from '../lib/updateResultText'`. State: `updateResult`, `checking`, `skippedVersion`. `refreshSkipped` moves across from lines 70-75 and keeps its comment; the effect that called it becomes a mount effect with an empty dependency array. The `<section>` wraps lines 420-484 verbatim **minus** the version `<span data-testid="update-current-version">` on lines 422-424, which Task 3 moves to the footer; until then, keep the whole header row here so nothing changes for `settingsUpdate.spec.ts`. Take `version` and its `appVersion()` effect with it in this task, and move both to the shell in Task 3.

- [ ] **Step 6: Reduce `SettingsPane.tsx` to a shell**

```tsx
import type { NotificationConfig } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { HooksSection } from './settings/HooksSection'
import { ShellHistorySection } from './settings/ShellHistorySection'
import { NotificationsSection } from './settings/NotificationsSection'
import { UpdatesSection } from './settings/UpdatesSection'

export function SettingsPane({
  open,
  onOpenChange,
  notifications,
  onNotificationsChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bounded and scrollable, which it was not until the shell-history row
          grew its disclosure paragraph. `DialogContent` centres itself with a
          -50% translate and sets no height, so a dialog taller than the window
          hangs off both ends with no way to reach either: measured 2026-08-06,
          the Updates row's `Check now` button went out of the viewport and
          Playwright's own scroll-into-view could not bring it back, because
          there was no scroll container to scroll. Five sections is already
          more than a short window holds, so this is not about one paragraph. */}
      <DialogContent data-testid="settings-pane" className="scroll-thin max-h-[85vh] overflow-y-auto">
        <DialogTitle className="mb-3 text-xs uppercase tracking-wider text-faint">
          Settings
        </DialogTitle>
        <HooksSection />
        <ShellHistorySection />
        <NotificationsSection
          notifications={notifications}
          onNotificationsChange={onNotificationsChange}
        />
        <UpdatesSection />
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 7: Verify the move kept the copy**

```bash
npm run typecheck
git show HEAD:src/renderer/SettingsPane.tsx | sed -n '241,328p' > /tmp/old-shell.txt
diff <(sed -n '/<section/,/<\/section>/p' src/renderer/settings/ShellHistorySection.tsx | sed '1d;$d') /tmp/old-shell.txt
```
Expected: tsc silent, and the diff shows only indentation changes, no changed words. Any changed word in the disclosure paragraph is a defect, not a tidy-up.

- [ ] **Step 8: Run the three existing e2e specs, unedited**

```bash
npx playwright test tests/e2e/settingsUpdate.spec.ts tests/e2e/shellHistorySettings.spec.ts
npx playwright test tests/e2e/status.spec.ts
```
Expected: all pass with no edits to any spec file. If a spec needs a change here, the move was not a move; find what changed and put it back.

- [ ] **Step 9: Commit**

```bash
npm test && npm run typecheck
grep -rn $'\u2014' src/renderer/settings src/renderer/SettingsPane.tsx   # expect no output
git add src/renderer/settings src/renderer/SettingsPane.tsx
git commit -m "Split the settings sections into one file each"
```

---

### Task 3: The tab strip, the shell and the footer

**Files:**
- Create: `src/renderer/settings/SettingsTabs.tsx`
- Create: `src/renderer/settings/SettingsPane.tsx`
- Delete: `src/renderer/SettingsPane.tsx`
- Modify: `src/renderer/App.tsx:16` (the import)
- Modify: `src/renderer/settings/UpdatesSection.tsx` (drop the version span and its `appVersion()` effect)
- Create: `tests/e2e/settingsTabs.spec.ts`
- Modify: `tests/e2e/status.spec.ts` (~line 681), `tests/e2e/shellHistorySettings.spec.ts`, `tests/e2e/settingsUpdate.spec.ts`

**Interfaces:**
- Consumes: `SETTINGS_TABS`, `SettingsTabId`, `nextTabIndex` from Task 1; the four section components from Task 2.
- Produces: `SettingsTabs({ active, onSelect }: { active: SettingsTabId; onSelect: (id: SettingsTabId) => void })`, and `SettingsPane` at its new path with the same four props it has today.

- [ ] **Step 1: Write the failing e2e spec**

Create `tests/e2e/settingsTabs.spec.ts`:

```ts
/**
 * The settings pane's tab strip: which tab it opens on, that selecting one
 * unmounts the last, that the version footer is on every tab, and that the
 * arrow keys move the selection.
 *
 * The unmount assertions are `toHaveCount(0)`, not `not.toBeVisible()`. That
 * is the whole point of the test: hiding an inactive tab and unmounting it
 * look identical to a visibility assertion, and only unmounting gives each
 * section the fresh read on select that this design relies on.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { CHANNELS, type MenuCommand } from '../../src/shared/ipc'

const SOCKET = 'pterm-e2e-settingstabs'

// A typed assignment, not a bare string: a renamed `settings` variant fails
// to compile here rather than sending a command nothing listens for.
const SETTINGS_COMMAND: MenuCommand = 'settings'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  await mkdir(alphaCwd, { recursive: true })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'id-alpha', name: 'alpha', slug: 'alpha', cwd: alphaCwd, presets: [] }],
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
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const openSettings = async (): Promise<void> => {
  expect(CHANNELS.menuCommand).toBe('pterm:menuCommand')
  expect(SETTINGS_COMMAND).toBe('settings')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })
  await expect(page.getByTestId('settings-pane')).toBeVisible()
}

test('opens on Notifications and mounts only that section', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await openSettings()

  await expect(page.getByTestId('settings-tab-notifications')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('mute-when-focused')).toBeVisible()

  // The other three sections are not in the DOM at all.
  await expect(page.getByTestId('hooks-status')).toHaveCount(0)
  await expect(page.getByTestId('shell-history-status')).toHaveCount(0)
  await expect(page.getByTestId('update-check-now')).toHaveCount(0)
})

test('selecting a tab mounts its section and unmounts the last', async () => {
  await page.getByTestId('settings-tab-hooks').click()
  await expect(page.getByTestId('hooks-status')).toBeVisible()
  await expect(page.getByTestId('mute-when-focused')).toHaveCount(0)

  await page.getByTestId('settings-tab-shell-history').click()
  await expect(page.getByTestId('shell-history-status')).toBeVisible()
  await expect(page.getByTestId('hooks-status')).toHaveCount(0)

  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-check-now')).toBeVisible()
  await expect(page.getByTestId('shell-history-status')).toHaveCount(0)
})

test('the version footer is on every tab', async () => {
  // Still on Updates from the test above. The footer belongs to the shell, so
  // it must survive every selection, including the tab it used to live on.
  await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)
  for (const id of ['notifications', 'hooks', 'shell-history']) {
    await page.getByTestId(`settings-tab-${id}`).click()
    await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)
  }
})

test('the arrow keys move the selection', async () => {
  // Land on a known tab first: this file shares one page across its tests, so
  // "wherever the last test left it" is not a starting point.
  await page.getByTestId('settings-tab-notifications').click()
  await expect(page.getByTestId('settings-tab-notifications')).toHaveAttribute('aria-selected', 'true')

  await page.getByTestId('settings-tab-notifications').press('ArrowRight')
  await expect(page.getByTestId('settings-tab-hooks')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('hooks-status')).toBeVisible()

  // Wrapping backwards off the first tab reaches the last.
  await page.getByTestId('settings-tab-hooks').press('ArrowLeft')
  await page.getByTestId('settings-tab-notifications').press('ArrowLeft')
  await expect(page.getByTestId('settings-tab-updates')).toHaveAttribute('aria-selected', 'true')
})

test('reopening the pane goes back to Notifications', async () => {
  await page.getByTestId('settings-tab-updates').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-pane')).toHaveCount(0)

  await openSettings()
  await expect(page.getByTestId('settings-tab-notifications')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('update-check-now')).toHaveCount(0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/settingsTabs.spec.ts`
Expected: FAIL on the first test, `settings-tab-notifications` resolving to 0 elements.

- [ ] **Step 3: Write the tab strip**

Create `src/renderer/settings/SettingsTabs.tsx`:

```tsx
import { useRef } from 'react'
import { cn } from '../lib/cn'
import { SETTINGS_TABS, nextTabIndex, type SettingsTabId } from './tabs'

/**
 * The settings pane's line tabs.
 *
 * Hand-rolled rather than Radix: `@radix-ui/react-tabs` is not a dependency
 * of this project and this is 40 lines. The arrow-key handling below is
 * therefore ours, written out, not a capability assumed from a library.
 *
 * Inactive tabs are drawn in `text-label`, not `text-faint`, which measures
 * 1.86:1 on `--color-surface`. See `tests/unit/labelContrast.test.ts`.
 */
export function SettingsTabs({
  active,
  onSelect,
}: {
  active: SettingsTabId
  onSelect: (id: SettingsTabId) => void
}) {
  // Keyed by tab id so an arrow key can move focus to the tab it selects.
  // Without this the roving tabIndex moves but the focus ring does not, and a
  // second arrow press comes from the old button.
  const buttons = useRef<Partial<Record<SettingsTabId, HTMLButtonElement | null>>>({})
  const index = SETTINGS_TABS.findIndex((tab) => tab.id === active)

  return (
    <div role="tablist" aria-label="Settings sections" className="mb-3 flex gap-4 border-b border-border">
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(node) => {
            buttons.current[tab.id] = node
          }}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`settings-panel-${tab.id}`}
          data-testid={`settings-tab-${tab.id}`}
          // Roving tabIndex: one stop for the whole strip, arrows move within
          // it. That is what a tablist is expected to do, and it keeps Tab
          // from walking four buttons before reaching the section.
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            const next = nextTabIndex(index, event.key, SETTINGS_TABS.length)
            if (next === index) return
            event.preventDefault()
            const target = SETTINGS_TABS[next]
            onSelect(target.id)
            buttons.current[target.id]?.focus()
          }}
          className={cn(
            '-mb-px cursor-default border-b px-0.5 pb-1.5 text-[11px] uppercase tracking-wider',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            tab.id === active
              ? 'border-fg text-fg'
              : 'border-transparent text-label hover:text-fg',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Write the new shell**

Create `src/renderer/settings/SettingsPane.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { NotificationConfig } from '../../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from '../ui/Dialog'
import { SettingsTabs } from './SettingsTabs'
import { SETTINGS_TABS, type SettingsTabId } from './tabs'
import { HooksSection } from './HooksSection'
import { ShellHistorySection } from './ShellHistorySection'
import { NotificationsSection } from './NotificationsSection'
import { UpdatesSection } from './UpdatesSection'

export function SettingsPane({
  open,
  onOpenChange,
  notifications,
  onNotificationsChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
}) {
  const [tab, setTab] = useState<SettingsTabId>(SETTINGS_TABS[0].id)
  const [version, setVersion] = useState<string | null>(null)

  // The version is decoration next to a dialog that already works, so a failed
  // read leaves the ellipsis in place rather than needing a place to show an
  // error. Unlike the sections' reads, it cannot change while the app runs, so
  // it is read once for the life of the window rather than on each open.
  useEffect(() => {
    window.pterm
      .appVersion()
      .then(setVersion)
      .catch(() => undefined)
  }, [])

  // The pane opens on the first tab every time. This component stays mounted
  // for the life of the window, so without this the tab you last looked at is
  // the tab you get, which is a preference nobody asked for and one more thing
  // to be wrong about.
  useEffect(() => {
    if (open) setTab(SETTINGS_TABS[0].id)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bounded and scrollable, which it was not until the shell-history row
          grew its disclosure paragraph. `DialogContent` centres itself with a
          -50% translate and sets no height, so a dialog taller than the window
          hangs off both ends with no way to reach either: measured 2026-08-06,
          the Updates row's `Check now` button went out of the viewport and
          Playwright's own scroll-into-view could not bring it back, because
          there was no scroll container to scroll. One tab's body is far
          shorter than the four stacked sections that provoked this, but a
          short window is still a short window. */}
      <DialogContent data-testid="settings-pane" className="scroll-thin max-h-[85vh] overflow-y-auto">
        <DialogTitle className="mb-3 text-xs uppercase tracking-wider text-label">
          Settings
        </DialogTitle>

        <SettingsTabs active={tab} onSelect={setTab} />

        {/* Only the selected section is mounted. Each one reads its own file
            on mount, so selecting a tab is what gives it a fresh read, and a
            tab nobody opens costs nothing. */}
        <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'notifications' ? (
            <NotificationsSection
              notifications={notifications}
              onNotificationsChange={onNotificationsChange}
            />
          ) : null}
          {tab === 'hooks' ? <HooksSection /> : null}
          {tab === 'shell-history' ? <ShellHistorySection /> : null}
          {tab === 'updates' ? <UpdatesSection /> : null}
        </div>

        <div className="mt-4 border-t border-border pt-2 text-[11px] text-label">
          pTerm <span data-testid="update-current-version">{version ?? '…'}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

The version stays alone inside its testid span: `settingsUpdate.spec.ts` asserts `toHaveText(/^\d+\.\d+\.\d+$/)` against it, and a `pTerm ` prefix inside the span would fail that.

- [ ] **Step 5: Strip the sections of what the shell now owns**

In `src/renderer/settings/UpdatesSection.tsx`, delete the `version` state, its `appVersion()` effect and the `<span data-testid="update-current-version">` from the header row, leaving the "Updates" heading. Also drop the now-redundant `mb-4 border-b border-border pb-3` from each section's root `<section>`: the strip draws the only rule the dialog needs, and Updates in particular was drawing a rule under the end of the dialog. Each root becomes a bare `<section>`.

Delete `src/renderer/SettingsPane.tsx` and repoint the import in `src/renderer/App.tsx:16`:

```tsx
import { SettingsPane } from './settings/SettingsPane'
```

- [ ] **Step 6: Run the new spec**

Run: `npx playwright test tests/e2e/settingsTabs.spec.ts`
Expected: 5 tests pass.

- [ ] **Step 7: Add the tab click to the three existing specs**

`tests/e2e/status.spec.ts`, after the `settings-open` click at ~line 681 and before the `hooks-status` assertion:

```ts
  await window.getByTestId('settings-open').click()
  // The hooks rows moved behind a tab. Notifications is what the pane opens
  // on, so nothing under Hooks is in the DOM until this click.
  await window.getByTestId('settings-tab-hooks').click()
  await expect(window.getByTestId('hooks-status')).toHaveText('not installed')
```

`tests/e2e/shellHistorySettings.spec.ts`, after the `settings-pane` visibility assertion and before the `shell-history-status` one:

```ts
  await expect(page.getByTestId('settings-pane')).toBeVisible()
  // The shell-history rows moved behind a tab; the pane opens on Notifications.
  await page.getByTestId('settings-tab-shell-history').click()
  await expect(page.getByTestId('shell-history-status')).toHaveText('not installed')
```

`tests/e2e/settingsUpdate.spec.ts`: the version assertion stays where it is and needs no click, because the footer belongs to the shell. Add the click before `update-check-now`:

```ts
  await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)

  // Everything below is behind the Updates tab; the version above is not,
  // which is the point of the footer.
  await page.getByTestId('settings-tab-updates').click()
  await page.getByTestId('update-check-now').click()
```

- [ ] **Step 8: Run every affected spec**

```bash
npx playwright test tests/e2e/settingsTabs.spec.ts tests/e2e/settingsUpdate.spec.ts tests/e2e/shellHistorySettings.spec.ts
npx playwright test tests/e2e/status.spec.ts
```
Expected: all pass. `status.spec.ts` is long and covers much more than settings; if it goes red, read which test failed before assuming this change caused it. A `beforeAll` timeout waiting for the window is the known crash-restore flake, not a settings failure, and Playwright reruns the rest of the file after any red, so one real failure can print several.

- [ ] **Step 9: Full gates and commit**

```bash
npm test && npm run typecheck
grep -rn $'\u2014' src/renderer/settings src/renderer/App.tsx tests/e2e/settingsTabs.spec.ts   # expect no output
grep -rn "SettingsPane" src/renderer | grep -v "src/renderer/settings/"   # expect only App.tsx's import
git add src/renderer/settings src/renderer/SettingsPane.tsx src/renderer/App.tsx tests/e2e
git commit -m "Put the settings sections behind line tabs with a version footer"
```

---

### Task 4: Make the settings headings readable

The section headings inside the pane are `text-faint` on `bg-surface`. That pair measures 1.86:1, which is the exact regression `--color-label` and `tests/unit/labelContrast.test.ts` were added to fix for the column headings; the settings pane never got the fix. Cleaning up this pane without it would leave the tidied version just as hard to read.

**Files:**
- Modify: `src/renderer/settings/HooksSection.tsx`, `ShellHistorySection.tsx`, `NotificationsSection.tsx`, `UpdatesSection.tsx`
- Test: `tests/unit/labelContrast.test.ts`

**Interfaces:**
- Consumes: the four section files from Tasks 2 and 3.
- Produces: nothing new. A class change and one more assertion.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe('the section-label colour', ...)` in `tests/unit/labelContrast.test.ts`:

```ts
  // The settings pane drew its section headings in `text-faint` on
  // `bg-surface` until 2026-08-07, which is the same 1.86:1 pair this file
  // exists because of. It was missed the first time because that fix went
  // through `ui/Panel.tsx`, which the settings sections do not use.
  it('is what the settings sections draw their headings in', () => {
    const dir = new URL('../../src/renderer/settings/', import.meta.url)
    for (const file of [
      'HooksSection.tsx',
      'ShellHistorySection.tsx',
      'NotificationsSection.tsx',
      'UpdatesSection.tsx',
    ]) {
      const source = readFileSync(new URL(file, dir), 'utf8')
      expect(source).toContain('text-label')
      expect(source).not.toContain('text-faint')
    }
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- labelContrast`
Expected: FAIL, `text-faint` found in all four section files.

- [ ] **Step 3: Make the change**

In each of the four section files, replace `text-faint` with `text-label` on the heading spans. The collision note inside `HooksSection` (`<p className="text-faint">pTerm ships its own sounds off by default…</p>`) becomes `text-label` too: it is body copy under a warning and the same argument applies.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- labelContrast && npm run typecheck`
Expected: pass, tsc silent.

- [ ] **Step 5: Look at it**

Run the app (`npm start`), open Settings from the sidebar gear, and read all four tabs. A test that counts class names cannot tell you the headings are legible, only that they are not the colour that was not. Confirm the tab strip's active underline is visible and the inactive labels are readable.

- [ ] **Step 6: Commit**

```bash
npm test && npm run typecheck
grep -rn $'\u2014' src/renderer/settings tests/unit/labelContrast.test.ts   # expect no output
git add src/renderer/settings tests/unit/labelContrast.test.ts
git commit -m "Draw the settings headings in the readable label colour"
```

---

## Self-review notes

**Spec coverage.** Four tabs, one per section (Tasks 2 and 3). Order and default (Task 1's list, asserted in Task 3's first test). Version in a footer (Task 3, Steps 4 and 5). One file per section (Task 2). Hand-rolled strip with explicit arrow keys (Task 1 arithmetic, Task 3 component, Task 3 Step 1 test). Inactive tabs unmounted (Task 3 test, `toHaveCount(0)`). Three spec edits plus the new spec (Task 3, Steps 1 and 7). Copy unchanged (Task 2 Step 7 diff, Task 2 Step 8 unedited specs).

**Beyond the spec.** Task 4 was not in the approved design. It is here because the pane's headings are drawn in a colour this repo already measured as unreadable and wrote a test about, and this is the one change that touches every one of those headings. It is last and independent, so it can be dropped without disturbing Tasks 1 to 3.

**Also decided while planning.** The spec says the pane opens on Notifications every time; `SettingsPane` outlives any single open, so Task 3 resets the tab on open and Task 3's last test proves it. The spec did not say this because it did not notice the component stays mounted.
