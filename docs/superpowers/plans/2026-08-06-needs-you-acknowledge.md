# Needs You Acknowledge Tick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a tick at the end of every `NEEDS YOU` row that marks the tab actioned, so a row you have read and decided about leaves the list without typing into the Claude session.

**Architecture:** One new registry method, `acknowledge(tabId)`, maps `waiting` to `idle` and `crashed` to `ended` and emits the ordinary transition, so the sidebar dot, the `statusChanged` broadcast and the dock badge all follow the path they already follow. The transition carries a new `quiet` flag that the notification router alone honours, so acknowledging never toasts. A fire-and-forget IPC channel in the shape of `dismissTab` connects the tick to it.

**Tech Stack:** Electron main/preload/renderer, TypeScript strict, React, Tailwind, Vitest for unit, Playwright (`_electron`) for e2e.

**Spec:** `docs/superpowers/specs/2026-08-06-needs-you-acknowledge-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, copy, commit messages. Use commas, colons, parentheses or separate sentences.
- TypeScript strict. `npx tsc --noEmit` must be clean before every commit.
- Unit tests: `npx vitest run <file>`. E2E: `npx playwright test <file>`. The e2e global setup packages the app itself, so no manual build step is needed.
- Comments state what was measured or decided, not what a plan told someone to write. If a claim in a comment is not verified, do not write it.
- E2E runs launch the app hidden (`PRCLI_BACKGROUND_WINDOW`, set by `tests/e2e/harness.ts`). Nothing appears on screen; that is expected, not a failure.

## File Structure

| File | Responsibility for this feature |
| --- | --- |
| `src/main/status/registry.ts` | `acknowledge()`, and the `quiet` flag on `StatusTransition` / `set` |
| `src/main/notify/router.ts` | Skip the toast and the sound for a `quiet` transition, still refresh the badge |
| `src/shared/ipc.ts` | `CHANNELS.acknowledgeTab` and the `acknowledgeTab` method on the bridge interface |
| `src/preload/index.ts` | Bridge implementation, `ipcRenderer.send` |
| `src/main/ipc/register.ts` | `ipcMain.on` handler calling `registry.acknowledge` |
| `src/renderer/NeedsYou.tsx` | Row becomes a container holding the jump button and the tick |
| `src/renderer/Sidebar.tsx` | Passes the new callback through |
| `src/renderer/App.tsx` | Wires the callback to `window.prcli.acknowledgeTab` |
| `tests/unit/registry.test.ts` | `acknowledge` behaviour, including the no-ops |
| `tests/unit/router.test.ts` | `quiet` suppresses toast and sound, badge still refreshes |
| `tests/e2e/status.spec.ts` | The tick, end to end, against a real injected hook and the real dock badge |

---

### Task 1: `StatusRegistry.acknowledge` and the `quiet` flag

**Files:**
- Modify: `src/main/status/registry.ts` (the `StatusTransition` interface near line 6, `set` near line 55, and a new method beside `forget` near line 127)
- Test: `tests/unit/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `acknowledge(tabId: string): void` on `StatusRegistry`
  - `StatusTransition.quiet?: boolean`
  - `set`'s options object gains `quiet?: boolean`

Read before starting: `set` at `src/main/status/registry.ts:55`, and its existing `silent` option. `silent` returns *before* the listener loop, so a `silent` change reaches nobody: not the renderer broadcast in `register.ts:502`, not the badge. `quiet` is the opposite split, and the two must not be merged.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('StatusRegistry', ...)` block in `tests/unit/registry.test.ts`:

```ts
  it('acknowledging a waiting tab leaves it idle, and says so', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyHook(hook(ID, 'Notification'))
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(ID)

    expect(registry.get(ID)).toBe('idle')
    expect(seen).toEqual([{ tabId: ID, from: 'waiting', to: 'idle', quiet: true }])
  })

  it('acknowledging a crashed tab leaves it ended, not idle', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyDead(ID, { status: 3 })
    expect(registry.get(ID)).toBe('crashed')
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(ID)

    expect(registry.get(ID)).toBe('ended')
    expect(seen).toEqual([{ tabId: ID, from: 'crashed', to: 'ended', quiet: true }])
  })

  // The pane is still dead and a client exit that lands after it still says
  // nothing, so the verdict that death recorded has to outrank a late
  // `applyExit` exactly as it did before the acknowledgement.
  it('keeps a dead pane explained after its crash is acknowledged', () => {
    const registry = new StatusRegistry()
    registry.applyDead(ID, { status: 3 })
    registry.acknowledge(ID)

    registry.applyExit(ID, 0)

    expect(registry.get(ID)).toBe('ended')
  })

  it('acknowledging a tab that is not blocking anyone changes nothing', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyHook(hook(ID, 'UserPromptSubmit'))
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(ID)

    expect(registry.get(ID)).toBe('thinking')
    expect(seen).toEqual([])
  })

  it('acknowledging a tab it has never seen emits nothing', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(OTHER)

    expect(registry.get(OTHER)).toBeNull()
    expect(seen).toEqual([])
  })
```

`{ status: 3 }` is the `PaneDeath` shape `tests/unit/registry.test.ts:103` already uses for a crash. The `expect(registry.get(ID)).toBe('crashed')` line before the acknowledgement is not decoration: it is what stops the test passing on a tab that was never crashed in the first place.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: FAIL, `registry.acknowledge is not a function`.

- [ ] **Step 3: Add `quiet` to the transition and to `set`**

In `src/main/status/registry.ts`, add to the `StatusTransition` interface:

```ts
  /**
   * Emit this transition, but do not announce it.
   *
   * Distinct from `set`'s `silent`, which emits nothing at all: a silent
   * change never reaches the renderer or the dock badge, which is right for a
   * spool replay and wrong for a user action. `quiet` is for a change the user
   * asked for, where the dot and the badge must move and a toast about it
   * would be noise.
   */
  quiet?: boolean
```

Widen `set`'s options and pass it through:

```ts
  private set(
    tabId: string,
    to: TabState,
    options: { silent?: boolean; tab?: TabDescriptor; quiet?: boolean } = {},
  ): void {
```

and in its listener loop:

```ts
    for (const listener of this.listeners)
      listener({ tabId, from, to, tab: options.tab, quiet: options.quiet })
```

`toEqual` ignores properties whose value is `undefined`, so the existing transition assertions in this file keep passing unchanged. Confirm that in Step 5 rather than trusting it.

- [ ] **Step 4: Write `acknowledge`**

Beside `forget` in the same class:

```ts
  /**
   * The user has dealt with this tab, without the session having said so.
   *
   * `waiting` becomes `idle` (alive, not blocking you) and `crashed` becomes
   * `ended` (dead, and `idle` would be a lie about it). Every other state is
   * left alone: an acknowledgement that raced a real state change must not
   * invent one.
   *
   * `explained` is deliberately untouched. A crash that has been acknowledged
   * is still a crash, so the late client exit that always follows a pane death
   * still has nothing to say.
   */
  acknowledge(tabId: string): void {
    const from = this.states.get(tabId)
    if (from !== 'waiting' && from !== 'crashed') return
    this.set(tabId, from === 'crashed' ? 'ended' : 'idle', { quiet: true })
  }
```

- [ ] **Step 5: Run the whole unit file**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: PASS, including every pre-existing test in the file. A failure in an old test means `quiet` is being emitted where it should be absent.

Then: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/main/status/registry.ts tests/unit/registry.test.ts
git commit -m "Let the registry acknowledge a tab that is blocking you"
```

---

### Task 2: The router ignores a quiet transition

**Files:**
- Modify: `src/main/notify/router.ts` (the `notify` method near line 90)
- Test: `tests/unit/router.test.ts`

**Interfaces:**
- Consumes: `StatusTransition.quiet` from Task 1.
- Produces: nothing new. Behaviour only.

Read before starting: `handle` at `src/main/notify/router.ts:78`. It calls `notify` inside a `try` and refreshes the badge in a `finally`, so a `return` inside `notify` skips the toast and keeps the badge. That is the property this task depends on, and the third test below is what pins it.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('NotificationRouter', ...)` in `tests/unit/router.test.ts`:

```ts
  // The default rules toast on `idle`, so an acknowledgement of a `waiting`
  // tab would fire a toast about the very thing the user just dismissed.
  it('says nothing about a quiet transition', async () => {
    const { router, toasts, sounds } = build()

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle', quiet: true })

    expect(toasts).toEqual([])
    expect(sounds).toEqual([])
  })

  // The count is about every other tab as much as this one, and the badge is
  // the whole reason `quiet` is not `silent`.
  it('still refreshes the badge for a quiet transition', async () => {
    const { router, badges } = build({ waitingCount: () => 3 })

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle', quiet: true })

    expect(badges).toEqual([3])
  })

  // The control: the same transition without the flag is a transition the
  // router does describe, so the test above cannot pass by the rule for
  // `idle` having been dropped.
  it('still describes the same transition without the flag', async () => {
    const { router, toasts } = build()

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle' })

    expect(toasts).toHaveLength(1)
  })
```

If the third test fails at Step 2 because no default rule toasts on `idle`, do not delete it: read `DEFAULT_NOTIFICATIONS` in `src/main/state/store.ts` and rewrite all three around a `to` state that the defaults do toast on, so the pair stays a real A/B. A quiet test whose non-quiet twin is also silent proves nothing.

- [ ] **Step 2: Run the tests and watch the first fail**

Run: `npx vitest run tests/unit/router.test.ts`
Expected: the first test FAILS (a toast is pushed), the second and third PASS.

- [ ] **Step 3: Honour the flag**

At the top of `notify` in `src/main/notify/router.ts`, before the `to === null` check:

```ts
    if (transition.quiet) return
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/router.test.ts`
Expected: PASS, all three plus every pre-existing test.

Then: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/main/notify/router.ts tests/unit/router.test.ts
git commit -m "Keep the notifier quiet about a state the user asked for"
```

---

### Task 3: The IPC channel

**Files:**
- Modify: `src/shared/ipc.ts` (the `CHANNELS` object near line 29, the bridge interface near line 656)
- Modify: `src/preload/index.ts` (near line 53, beside `dismissTab`)
- Modify: `src/main/ipc/register.ts` (beside the `CHANNELS.dismissTab` handler at line 1030)

**Interfaces:**
- Consumes: `registry.acknowledge(tabId)` from Task 1.
- Produces: `window.prcli.acknowledgeTab(id: string): void`, and `CHANNELS.acknowledgeTab === 'prcli:acknowledgeTab'`.

This task has no test of its own: it is three lines of wiring whose only observable behaviour is the end-to-end path Task 5 asserts. Commit it with Task 4 if you prefer, but do not invent a unit test that only restates the wiring.

- [ ] **Step 1: Add the channel**

In `src/shared/ipc.ts`, beside `dismissTab: 'prcli:dismissTab',`:

```ts
  acknowledgeTab: 'prcli:acknowledgeTab',
```

- [ ] **Step 2: Add the bridge method**

In the same file, in the bridge interface beside `dismissTab(id: string): void`:

```ts
  /**
   * Mark a tab actioned: `waiting` becomes `idle`, `crashed` becomes `ended`.
   *
   * Fire and forget. The new state arrives back through `onStatus` like every
   * other state change, so the renderer never has to hold an opinion of its
   * own about what it just asked for.
   */
  acknowledgeTab(id: string): void
```

- [ ] **Step 3: Implement it in the preload**

In `src/preload/index.ts`, beside the `dismissTab` line:

```ts
  acknowledgeTab: (id) => ipcRenderer.send(CHANNELS.acknowledgeTab, id),
```

- [ ] **Step 4: Handle it in main**

In `src/main/ipc/register.ts`, beside the `CHANNELS.dismissTab` handler:

```ts
  ipcMain.on(CHANNELS.acknowledgeTab, (_event, id: string) => {
    registry.acknowledge(id)
  })
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output. A missing bridge implementation shows up here, which is the point of doing this step before any UI exists.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/ipc/register.ts
git commit -m "Carry an acknowledgement from the renderer to the registry"
```

---

### Task 4: The tick

**Files:**
- Modify: `src/renderer/NeedsYou.tsx`
- Modify: `src/renderer/Sidebar.tsx` (props near line 24 and 43, the `<NeedsYou .../>` call at line 94)
- Modify: `src/renderer/App.tsx` (the `<Sidebar .../>` call near line 1028)

**Interfaces:**
- Consumes: `window.prcli.acknowledgeTab` from Task 3.
- Produces: `NeedsYou`'s `onAcknowledge: (tab: TabDescriptor) => void` prop, `Sidebar`'s `onAcknowledgeNeedy: (tab: TabDescriptor) => void` prop, and the `ack-<tabId>` testid.

Keep `data-testid={`needs-${tab.id}`}` on the jump button, not on the new container. `tests/e2e/status.spec.ts:278` clicks it and expects a jump, and moving it to a wrapper that also contains the tick would make that click's target ambiguous.

- [ ] **Step 1: Rebuild the row in `src/renderer/NeedsYou.tsx`**

Add `onAcknowledge` to the props type beside `onSelect`:

```tsx
  onAcknowledge: (tab: TabDescriptor) => void
```

Replace the single `<button>` per tab with a container holding two buttons. A button nested inside a button is invalid HTML and gives Playwright two elements for one row:

```tsx
        return (
          <div key={tab.id} className="flex w-full items-center">
            <button
              data-testid={`needs-${tab.id}`}
              onClick={() => onSelect(tab)}
              className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 border-none bg-transparent px-2.5 py-0.5 text-left text-muted hover:text-fg"
            >
              <StatusDot state={status[tab.id] ?? null} testid={`ndot-${tab.id}`} />
              <span className="truncate">
                {project?.name ?? 'Unsorted'} · {tab.id.slice(0, 6)}
              </span>
            </button>
            <button
              data-testid={`ack-${tab.id}`}
              aria-label="Mark actioned"
              title="Mark actioned"
              onClick={() => onAcknowledge(tab)}
              className="shrink-0 cursor-default border-none bg-transparent px-2 py-0.5 text-muted hover:text-fg"
            >
              ✓
            </button>
          </div>
        )
```

The tick is drawn without hover on purpose: a control you can only find by hovering does not exist for the first hour of using the app.

- [ ] **Step 2: Pass it through `src/renderer/Sidebar.tsx`**

Add `onAcknowledgeNeedy` to the destructured props and to the props type, both beside `onSelectNeedy`:

```tsx
  onAcknowledgeNeedy: (tab: TabDescriptor) => void
```

and at the call site on line 94:

```tsx
      <NeedsYou
        tabs={needsYou}
        projects={projects}
        status={status}
        onSelect={onSelectNeedy}
        onAcknowledge={onAcknowledgeNeedy}
      />
```

- [ ] **Step 3: Wire it in `src/renderer/App.tsx`**

Beside `onSelectNeedy` in the `<Sidebar .../>` call:

```tsx
          onAcknowledgeNeedy={(tab) => window.prcli.acknowledgeTab(tab.id)}
```

No local dispatch. `App.tsx:661` already turns every `onStatus` event into a `statusChanged` dispatch, so the new state arrives the same way a hook-driven one does, and there is one source of truth for what the dot shows.

- [ ] **Step 4: Typecheck and run the unit suite**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx vitest run`
Expected: PASS. This is the cheap check that no renderer unit test read the old row markup.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/NeedsYou.tsx src/renderer/Sidebar.tsx src/renderer/App.tsx
git commit -m "Put a tick on every Needs You row"
```

---

### Task 5: End to end

**Files:**
- Modify: `tests/e2e/status.spec.ts` (add after the existing `Needs You lists it, and clicking it lands on the tab` test, which ends at line 283)

**Interfaces:**
- Consumes: everything above. `ack-<tabId>`, `needs-<tabId>`, `needs-you-count`, `dot-<tabId>`.
- Produces: nothing.

Read before starting: the `Needs You lists it` test at line 249 for the seed-and-open shape, and the dock badge assertion at line 461 for how the badge is read (`app.evaluate(({ app }) => app.dock?.getBadge())`, polled).

- [ ] **Step 1: Write the failing tests**

```ts
test('the tick clears a waiting tab, out of the list and off the badge', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const id = await openTab(window)
  await injectHook(id, 'Notification')
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'waiting')
  await expect(window.getByTestId('needs-you-count')).toHaveText('1')
  await expect
    .poll(async () => app.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge()))
    .toBe('1')

  await window.getByTestId(`ack-${id}`).click()

  // The dot is the assertion that separates this from a `forget`: the tab
  // keeps a state, and that state is `idle`.
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'idle')
  await expect(window.getByTestId('needs-you')).toHaveCount(0)
  await expect
    .poll(async () => app.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge()))
    .toBe('')

  await app.close()
})

// The row and the tick are two buttons in one container now. A click handler
// on the container, or a tick that does not stop at itself, would make one of
// these two do the other's job.
test('clicking the row still only jumps, and does not acknowledge', async () => {
  const alpha = await candidate('alpha')
  const beta = await candidate('beta')
  await seed(
    [
      { id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null },
      { id: 'id-beta', name: 'Beta', slug: 'beta', cwd: beta, presets: [], activeTabId: null },
    ],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await openTab(window)
  await window.getByTestId('project-id-beta').click()
  const needy = await openTab(window)
  await injectHook(needy, 'Notification')
  await expect(window.getByTestId(`dot-${needy}`)).toHaveAttribute('data-state', 'waiting')

  await window.getByTestId('project-id-alpha').click()
  await window.getByTestId(`needs-${needy}`).click()

  await expect(window.getByTestId(`tab-${needy}`)).toHaveAttribute('data-active', 'true')
  // Still listed, still waiting: a jump is not an acknowledgement.
  await expect(window.getByTestId('needs-you-count')).toHaveText('1')
  await expect(window.getByTestId(`dot-${needy}`)).toHaveAttribute('data-state', 'waiting')

  await app.close()
})
```

The `needs-you` container disappears entirely when the list empties (`NeedsYou.tsx` returns null), which is why the first test asserts `toHaveCount(0)` on the container rather than reading the count text.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx playwright test tests/e2e/status.spec.ts`
Expected: the first FAILS (no `ack-<id>` element), the second PASSES. Note the second one passing before any change: it is a regression guard for Task 4's restructure, so it must be green both before and after.

If Task 4 is already committed when you reach this step, expect both to pass; in that case verify the first one is real by temporarily removing the `onClick` on the tick, re-running, and confirming it fails. Put the handler back.

- [ ] **Step 3: Run the whole e2e suite**

Run: `npx playwright test`
Expected: PASS. The suite is serial and takes roughly 100 seconds. The tab-bar and Needs You locators in other files are the ones this change could have broken.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/status.spec.ts
git commit -m "Cover the acknowledge tick end to end"
```

---

## Verification

- [ ] `npx vitest run` clean
- [ ] `npx tsc --noEmit` clean
- [ ] `npx playwright test` clean
- [ ] No em dash in anything this work added. The repo is full of pre-existing ones, so grep the added lines only: `git diff <first-task-commit>~1..HEAD -- src tests | grep '^+' | grep -n '—'` returns nothing
- [ ] Open the app (`npm start`), let a Claude session go `waiting`, and click the tick: the row goes, the dot turns grey, the dock badge drops, and no toast appears. Gates have twice failed to see what only opening the app shows.
