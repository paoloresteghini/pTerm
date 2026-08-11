# Browser Pane (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `'browser'` pane type that renders a live web page inside the existing pane layout, keeps a per-project cookie jar, and survives relaunch.

**Architecture:** A browser pane is the third *sessionless* pane kind, beside `editor` and `diff`: it has no tmux session, so it is created by an IPC handler that writes a `PaneRecord` and a `TabRow` directly, and it is restored by `mergeSessionlessPanes` rather than by live tmux. The page is hosted in an Electron `<webview>` element inside the same flex box a terminal or editor occupies, so splits, ratios, dividers, drag-to-split and project switching need no changes at all. Per-project isolation comes from the webview's `partition` attribute.

**Tech Stack:** Electron 43.2.0, React 19, TypeScript 7.0.2, Tailwind 4, Vitest (`environment: 'node'`), Playwright 1.62.

Design spec: `docs/superpowers/specs/2026-08-11-browser-pane-design.md`. This plan covers **M1 only**. M2 (Claude control over CDP/MCP) and M3 (dev-server URL auto-detect, device widths, global pane) are out of scope and must not be built here.

## Global Constraints

- **No em dashes anywhere.** Not in code, comments, test names, commit messages, or the plan's own output. Use commas, colons, parentheses, or separate sentences.
- **Write your own comments. Do not transcribe comment text from this plan.** This plan states *facts* and *reasons*; turning a reason into a comment is your judgement, and the comment must be true of the branch at the commit you write it in, not merely true of the line beside it. A comment asserting something you have not verified is a defect in this codebase, and reviews here have caught exactly that.
- **New `data-testid` values must never begin with `tab-`.** More than 27 existing e2e locators count tabs with `[data-testid^="tab-"]`, and a new per-pane testid under that prefix silently inflates every one of those counts.
- **`toBeVisible()` is not proof of visibility here.** An element painted behind another passes it. Assert on content, geometry, or a value that could only be produced by the thing under test.
- **An auto-retrying assertion waits only for change.** `await expect(x).toHaveText('a')` immediately after an action is a no-op when the value already read `'a'`, and everything after it then races the action. Assert on a value the action must change.
- Do not add an always-on column or any new persistent chrome to the main layout. `splits.spec.ts` encodes the whole flex row in pixel constants and five of its tests fail on leftover terminal width if the chrome budget moves.
- Verification commands: `npm test` (vitest), `npm run typecheck` (`tsc --noEmit`), `npm run e2e` (playwright). Every task ends green on the first two. E2E runs where a task says so.
- Do not run `npm install`. The dependency set does not change in M1.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/shared/browserUrl.ts` | One pure function turning what a human typed into a loadable URL. Shared because both the renderer's URL bar and main's `openBrowser` normalise. |
| `src/renderer/BrowserPane.tsx` | The pane component: chrome (URL bar, nav buttons, DevTools toggle), the `<webview>`, and the failure cards (two, not three: see Task 7 for the one that was cut). |
| `tests/unit/browserUrl.test.ts` | The normaliser's table. |
| `tests/integration/openBrowser.test.ts` | The handler writes both records. |
| `tests/e2e/browser.spec.ts` | The pane end to end. |
| `tests/e2e/fixtures/browser-page.html` | A `file://` page for e2e to load. |
| `docs/superpowers/notes/2026-08-11-playwright-webview-reach.md` | The Task 5 spike's recorded findings. |

**Modified:**

| File | Change |
|---|---|
| `src/shared/ipc.ts` | `TabType` gains `'browser'`; `SESSIONLESS` gains `'browser'`; `TabDescriptor` gains `url?`; a `CHANNELS` entry and a `PTermApi` method for `openBrowser` and `setPaneUrl`. |
| `src/main/sessions/manager.ts` | `PaneRecord` gains `url?`. |
| `src/main/state/store.ts` | `isPane` per-kind guard, `TAB_TYPES`, `normalisePane` validating `url`. |
| `src/main/ipc/savedFields.ts` | Reattach `url`. |
| `src/main/status/machine.ts` | `stateForOpen` case. |
| `src/main/ipc/register.ts` | `openBrowser` and `setPaneUrl` handlers. |
| `src/preload/index.ts` | Two lines on the `api` object. |
| `src/main/index.ts` | `webviewTag: true`, plus the `will-attach-webview`, window-open and permission hardening. |
| `src/renderer/App.tsx` | One branch in the pane-kind ternary, one palette command, one `openBrowser` callback. |
| `src/renderer/lib/tabLabel.ts` | Browser case. |
| `tests/unit/savedFields.test.ts`, `store.test.ts`, `machine.test.ts`, `tabLabel.test.ts` | Cases for the new kind. |

**Deliberately unmodified.** `src/main/ipc/sessionlessPanes.ts`, `src/renderer/workspace.ts`, `src/renderer/TabBar.tsx`, `src/renderer/TabsPanel.tsx`, `src/renderer/Sidebar.tsx` and `closePane` in `register.ts` all route through `canHaveSession`, so they gain correct browser behaviour from Task 1 alone. If you find yourself editing one of them, stop: it means `'browser'` did not reach `SESSIONLESS`.

---

### Task 1: The pane kind exists and persists

**Files:**
- Modify: `src/shared/ipc.ts:144` (`TabType`), `:166` (`SESSIONLESS`), `:283` (`TabDescriptor`)
- Modify: `src/main/sessions/manager.ts:14` (`PaneRecord`)
- Modify: `src/main/state/store.ts:127` (`isPane`), `:130` (`TAB_TYPES`), `:132` (`normalisePane`)
- Modify: `src/main/ipc/savedFields.ts`
- Modify: `src/main/status/machine.ts:105`
- Test: `tests/unit/store.test.ts`, `tests/unit/savedFields.test.ts`, `tests/unit/machine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TabType` includes `'browser'`; `canHaveSession({ type: 'browser' })` returns `false`; `TabDescriptor.url?: string` and `PaneRecord.url?: string`; `attachSavedFields` carries `url`; `stateForOpen('browser')` returns `null`.

This is the load-bearing task. `SESSIONLESS` (`ipc.ts:166`) carries a doc comment stating that a pane kind missing from that list is silently written away by the `store.write` that follows a relaunch, with nothing logged. Every downstream consumer asks `canHaveSession`, so this one line is what makes a browser pane survive at all.

- [ ] **Step 1: Write the failing store test**

Add to `tests/unit/store.test.ts`, inside the existing describe block that exercises `isPane`:

```ts
it('keeps a browser row that has no tmux session', async () => {
  const store = await storeWith({
    ...sampleConfig,
    panes: [
      {
        id: 'b1',
        projectSlug: 'demo',
        cwd: '/tmp/demo',
        type: 'browser',
        url: 'http://localhost:3000/',
      },
    ],
  })
  const config = await store.read()
  expect(config.panes).toEqual([
    { id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 'http://localhost:3000/' },
  ])
})

it('keeps a browser row but drops a non-string url', async () => {
  const store = await storeWith({
    ...sampleConfig,
    panes: [{ id: 'b2', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 42 }],
  })
  const config = await store.read()
  expect(config.panes[0]?.type).toBe('browser')
  expect(config.panes[0]?.url).toBeUndefined()
})
```

The second test matters because config is a text file that a human edits. Every other optional field on this record is validated the same way, and an unvalidated `url` reaches the webview's `src` attribute.

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run tests/unit/store.test.ts -t browser`

Expected: FAIL. The first test receives `[]`, because `isPane` requires `typeof t.tmuxSession === 'string'` for any type other than `editor` or `diff`, so the row is rejected entirely. If it fails with a TypeScript error on `'browser'` instead, that is also RED and fine.

- [ ] **Step 3: Add the kind to the two lists in `ipc.ts`**

```ts
export type TabType = 'claude' | 'preset' | 'shell' | 'editor' | 'diff' | 'browser'
```

```ts
const SESSIONLESS: readonly TabType[] = ['editor', 'diff', 'browser']
```

Update the surrounding doc comments so they no longer say "two sessionless kinds now" and no longer enumerate only `editor` and `diff`. Those sentences become false with this edit, and a comment that was true per commit and false in the branch is a defect this codebase reviews for.

- [ ] **Step 4: Add `url` to both record shapes**

To `TabDescriptor` in `src/shared/ipc.ts` and `PaneRecord` in `src/main/sessions/manager.ts`, both as `url?: string`. Document what it is (the page a browser pane is showing, absent on every other kind and on a browser pane that has not navigated yet) and that it is the normalised absolute form, never what the user typed.

- [ ] **Step 5: Teach `store.ts` the kind**

`isPane`'s final line:

```ts
return (
  t.type === 'editor' ||
  t.type === 'diff' ||
  t.type === 'browser' ||
  typeof t.tmuxSession === 'string'
)
```

`TAB_TYPES`:

```ts
const TAB_TYPES: readonly TabType[] = ['claude', 'preset', 'shell', 'editor', 'diff', 'browser']
```

In `normalisePane`, add a `url` validation beside the existing `diffRelPath` one and thread it into the chain:

```ts
const urled = typeof related.url === 'string' ? related : { ...related, url: undefined }
if (TAB_TYPES.includes(urled.type)) return urled
return { ...urled, type: urled.command === undefined ? 'shell' : 'preset' }
```

Note that `related` is the last link in the existing chain, so `urled` must replace `related` in both of the final two lines. Leaving one of them referencing `related` compiles and silently drops the validation.

- [ ] **Step 6: Run the store test to green**

Run: `npx vitest run tests/unit/store.test.ts`

Expected: PASS, including every pre-existing test in the file. If `still rejects a terminal row with no session` now fails, the `isPane` edit was too broad.

- [ ] **Step 7: Write the failing `savedFields` and `machine` tests**

To `tests/unit/savedFields.test.ts`:

```ts
it('carries url onto a record that does not carry one', () => {
  const built: TabDescriptor[] = [
    { id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser' },
  ]
  const saved: PaneRecord[] = [
    { id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 'https://example.com/' },
  ]

  expect(attachSavedFields(built, saved)[0]?.url).toBe('https://example.com/')
})
```

To `tests/unit/machine.test.ts`, inside `describe('stateForOpen')`:

```ts
it('gives a browser pane no state, having no session to be waiting about', () => {
  expect(stateForOpen('browser')).toBeNull()
})
```

Called directly, for the reason the existing file header gives: routed through `restoreWorkspace` instead, the same assertion would pass with the implementation line deleted, because `mergeSessionlessPanes` hands the saved record itself back and there is nothing left to reattach. The discriminating input is a record that does *not* carry the field.

- [ ] **Step 8: Run them and confirm they fail**

Run: `npx vitest run tests/unit/savedFields.test.ts tests/unit/machine.test.ts`

Expected: FAIL. `savedFields` receives `undefined` for `url`. `machine.test.ts` may instead fail to compile if the switch is not exhaustive, which is the same signal.

- [ ] **Step 9: Implement both**

In `attachSavedFields`, beside the existing field lines:

```ts
if (row.url) next.url = row.url
```

In `stateForOpen`, extend the existing sessionless case:

```ts
case 'editor':
case 'diff':
case 'browser':
  return null
```

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: all green. The typecheck is doing real work here: `stateForOpen`'s switch is exhaustive over `TabType`, so a missing case is a compile error rather than a runtime surprise, and any other exhaustive switch over `TabType` in the codebase surfaces now.

- [ ] **Step 11: Verify the free wins actually landed**

Run: `grep -rn "canHaveSession" src/`

Read each call site and confirm the browser kind now gets the behaviour it should: no restart affordance in `TabBar.tsx`, `TabsPanel.tsx` and `Sidebar.tsx`; not counted by `needsYou`; never `isDead`; `closePane` skips `manager.kill`; `mergeSessionlessPanes` treats it as restorable. You are reading, not editing. If any of these would need an edit, `SESSIONLESS` is wrong.

- [ ] **Step 12: Commit**

```bash
git add src/shared/ipc.ts src/main/sessions/manager.ts src/main/state/store.ts \
  src/main/ipc/savedFields.ts src/main/status/machine.ts \
  tests/unit/store.test.ts tests/unit/savedFields.test.ts tests/unit/machine.test.ts
git commit -m "Add browser as the third sessionless pane kind"
```

---

### Task 2: Turning what a human typed into a URL

**Files:**
- Create: `src/shared/browserUrl.ts`
- Test: `tests/unit/browserUrl.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normaliseUrl(input: string): string | null`. Returns `null` for input that cannot be a URL at all, which callers treat as "do nothing", never as an error to show.

The one daily papercut in this feature lives here. Defaulting a bare host to `https` is right for the web and wrong for every dev server, so loopback names are special-cased to `http`. Get it backwards and every URL you type by hand fails on TLS.

- [ ] **Step 1: Write the failing table**

Create `tests/unit/browserUrl.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normaliseUrl } from '../../src/shared/browserUrl'

describe('normaliseUrl', () => {
  const cases: [string, string | null][] = [
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost', 'http://localhost'],
    ['localhost:5173/app/settings', 'http://localhost:5173/app/settings'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['0.0.0.0:4000', 'http://0.0.0.0:4000'],
    ['[::1]:3000', 'http://[::1]:3000'],
    ['example.com', 'https://example.com'],
    ['example.com:8080', 'https://example.com:8080'],
    ['example.com/a/b?q=1', 'https://example.com/a/b?q=1'],
    ['http://example.com', 'http://example.com'],
    ['https://example.com', 'https://example.com'],
    ['about:blank', 'about:blank'],
    ['file:///tmp/x.html', 'file:///tmp/x.html'],
    ['  example.com  ', 'https://example.com'],
    ['', null],
    ['   ', null],
  ]

  for (const [input, expected] of cases) {
    it(`turns ${JSON.stringify(input)} into ${JSON.stringify(expected)}`, () => {
      expect(normaliseUrl(input)).toBe(expected)
    })
  }
})
```

`example.com:8080` is the discriminating case and is not decoration. A scheme test written as "letters followed by a colon" matches `localhost:3000` and `example.com:8080` both, and would return each unchanged, which is exactly the bug this table exists to prevent.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/browserUrl.test.ts`

Expected: FAIL, cannot resolve `../../src/shared/browserUrl`.

- [ ] **Step 3: Implement**

Create `src/shared/browserUrl.ts`:

```ts
const SCHEME = /^(https?|file|about|data|chrome|devtools|view-source):/i

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i

export function normaliseUrl(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  if (LOOPBACK.test(text)) return `http://${text}`
  if (SCHEME.test(text)) return text
  return `https://${text}`
}
```

Two orderings are load-bearing and both should be recorded in your own words in the file. The loopback test runs before the scheme test, because `localhost:3000` would otherwise have to be distinguished from a scheme by the scheme pattern alone. And the scheme pattern is an explicit allowlist rather than a general `[a-z][a-z0-9+.-]*:`, because the general form matches `example.com:8080`.

- [ ] **Step 4: Run to green**

Run: `npx vitest run tests/unit/browserUrl.test.ts`

Expected: PASS, 16 tests.

- [ ] **Step 5: Prove the table discriminates**

Temporarily swap the two `if` lines so `SCHEME` is tested first. Re-run.

Expected: `localhost:3000`, `localhost`, `localhost:5173/app/settings` and `example.com:8080` fail. Restore the order, re-run to green, and confirm `git diff src/shared/browserUrl.ts` is empty for that pair of lines before committing. Record the measured result in the test file's header. A table that passes with the logic inverted is a table that tests nothing, and this codebase has shipped exactly that kind of test before.

- [ ] **Step 6: Commit**

```bash
git add src/shared/browserUrl.ts tests/unit/browserUrl.test.ts
git commit -m "Normalise typed input into a loadable URL"
```

---

### Task 3: Opening a browser pane

**Files:**
- Modify: `src/shared/ipc.ts` (`CHANNELS` near `:67`, `PTermApi` near `:1211`)
- Modify: `src/main/ipc/register.ts` (a new handler beside `openEditor` at `:1978`)
- Modify: `src/preload/index.ts` (beside `:132`)
- Test: `tests/integration/openBrowser.test.ts`

**Interfaces:**
- Consumes: `normaliseUrl` from Task 2; `PaneRecord.url` and the `'browser'` kind from Task 1.
- Produces: `CHANNELS.openBrowser`; `openBrowser(projectId: string, url?: string): Promise<TabDescriptor | null>` on `PTermApi` and on `window.pterm`.

Cloned from `openEditor` (`register.ts:1978`) with **two differences**, in the way `openDiff` (`:2063`) already documents its three:

1. **No dedupe.** `openEditor` returns an existing pane when one already shows that file. Two browser panes on one URL is a legitimate thing to want (two routes of the same app, two viewport widths), so this handler always creates.
2. **No path resolution or containment guard.** A URL is not a path. There is nothing to resolve against the project cwd and nothing to keep inside it.

Everything else is identical and must stay identical: resolve the project or return null, mint the id with `newSessionId()`, and write the `PaneRecord` and the `TabRow` in one `store.write`. The tab row is not optional. `mergeSessionlessPanes` drops any sessionless pane that no tab row names, so a pane written without one vanishes on the next launch.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/openBrowser.test.ts`. Model the harness on `tests/integration/restore.test.ts` for how it stands a `ConfigStore` up on a temp file and drives handlers. The assertions that matter:

```ts
it('writes a pane row and a tab row that names it, in one write', async () => {
  const pane = await openBrowser('p1', 'localhost:3000')

  expect(pane?.type).toBe('browser')
  expect(pane?.url).toBe('http://localhost:3000')
  expect(pane?.projectSlug).toBe('demo')

  const config = await store.read()
  expect(config.panes.map((row) => row.id)).toContain(pane?.id)

  const row = config.tabs.find((tab) => tab.id === pane?.id)
  expect(row).toBeDefined()
  expect(row?.groupId).toBe(pane?.id)
  expect(row?.activePaneId).toBe(pane?.id)
  expect(row?.layout).toEqual({ dir: 'row', ratio: [1], kids: [pane?.id] })
})

it('creates a second pane for a URL already open, unlike openEditor', async () => {
  const first = await openBrowser('p1', 'https://example.com')
  const second = await openBrowser('p1', 'https://example.com')

  expect(second?.id).not.toBe(first?.id)
  const config = await store.read()
  expect(config.panes.filter((row) => row.type === 'browser')).toHaveLength(2)
})

it('answers null for a project that does not exist', async () => {
  expect(await openBrowser('nope', 'https://example.com')).toBeNull()
})

it('opens about:blank when no url is given', async () => {
  const pane = await openBrowser('p1')
  expect(pane?.url).toBe('about:blank')
})

it('survives a restore that live tmux knows nothing about', async () => {
  const pane = await openBrowser('p1', 'https://example.com')
  const config = await store.read()

  const merged = mergeSessionlessPanes({
    livePanes: [],
    liveTabs: [],
    savedPanes: config.panes,
    savedTabs: config.tabs,
  })

  expect(merged.panes.find((row) => row.id === pane?.id)?.url).toBe('https://example.com')
  expect(merged.tabs.find((row) => row.id === pane?.id)).toBeDefined()
})
```

That last test is the regression worth the most. It is the failure where the pane restores but is dropped, or restores stripped of its URL, and it is invisible without an explicit assertion because nothing throws.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/openBrowser.test.ts`

Expected: FAIL, `CHANNELS.openBrowser` does not exist.

- [ ] **Step 3: Add the channel and the API signature**

In `src/shared/ipc.ts`, beside `openEditor` in `CHANNELS`:

```ts
openBrowser: 'pterm:openBrowser',
```

and on `PTermApi`, beside `openEditor`:

```ts
openBrowser(projectId: string, url?: string): Promise<TabDescriptor | null>
```

- [ ] **Step 4: Implement the handler**

In `src/main/ipc/register.ts`, immediately after the `openDiff` handler so the three sessionless openers read together:

```ts
ipcMain.handle(
  CHANNELS.openBrowser,
  (_event, projectId: string, url?: string): Promise<TabDescriptor | null> =>
    serialise(async () => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return null

      const id = newSessionId()
      const pane: PaneRecord = {
        id,
        projectSlug: project.slug,
        cwd: project.cwd,
        type: 'browser',
        url: (url === undefined ? null : normaliseUrl(url)) ?? 'about:blank',
      }
      const row: TabRow = {
        id,
        groupId: id,
        activePaneId: id,
        layout: { dir: 'row', ratio: [1], kids: [id] },
      }

      await store.write({
        ...config,
        panes: [...config.panes, pane],
        tabs: withTabRow(config.tabs, id, row),
      })
      return pane
    }),
)
```

`serialise` is required because this writes config. The `openEditor` handler carries a comment block explaining exactly when to serialise and when not to; read it rather than guessing.

- [ ] **Step 5: Expose it in the preload**

In `src/preload/index.ts`, beside the `openEditor` line:

```ts
openBrowser: (projectId, url) => ipcRenderer.invoke(CHANNELS.openBrowser, projectId, url),
```

- [ ] **Step 6: Run to green**

Run: `npx vitest run tests/integration/openBrowser.test.ts && npm run typecheck`

Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/register.ts src/preload/index.ts \
  tests/integration/openBrowser.test.ts
git commit -m "Open a browser pane from main, writing pane and tab in one write"
```

---

### Task 4: The webview, enabled safely, rendering a page

**Files:**
- Create: `src/renderer/BrowserPane.tsx`
- Modify: `src/main/index.ts:490-493` (webPreferences) and the app-ready path
- Modify: `src/renderer/App.tsx:1659` (the pane-kind ternary), plus an `openBrowserPane` callback near `openFile` at `:521` and a palette command at `:2238`

**Interfaces:**
- Consumes: `TabDescriptor.url`, `normaliseUrl`, `window.pterm.openBrowser`.
- Produces: `<BrowserPane paneId={string} projectId={string | undefined} url={string | undefined} paneColor={PaneColor | undefined} />`.

**The hardening ships in this commit, not a later one.** Enabling `webviewTag` widens the main window's attack surface, and a commit that turns it on without `will-attach-webview` is an insecure intermediate state that could be released. Reviewers should reject this task if the two are split.

- [ ] **Step 1: Enable the tag and harden it in the same edit**

In `src/main/index.ts`, add to the existing `webPreferences` beside `contextIsolation: true, nodeIntegration: false`:

```ts
webviewTag: true,
```

Then, on the window's `webContents`, immediately after the `BrowserWindow` is constructed:

```ts
mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.contextIsolation = true
  delete params.nodeintegration
  delete params.allowpopups
})
```

And on the partition sessions, so a page cannot prompt for hardware. Register this once, at app ready, for any session whose partition name starts with the project prefix:

```ts
app.on('session-created', (created) => {
  created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
})
```

Denying every permission outright is the M1 position. A page that wants the camera is not a thing this pane needs to serve, and a prompt that appears inside a pane with no window chrome has nowhere sensible to render.

- [ ] **Step 2: Write the component**

Create `src/renderer/BrowserPane.tsx`. It renders a column: a chrome strip, then the webview filling the rest.

```tsx
export function BrowserPane({
  paneId,
  url,
  paneColor,
}: {
  paneId: string
  url: string | undefined
  paneColor: PaneColor | undefined
}) {
  const view = useRef<Electron.WebviewTag | null>(null)
  const [address, setAddress] = useState(url ?? 'about:blank')
  const [typed, setTyped] = useState(address)

  return (
    <div className="flex h-full flex-col" data-testid={`browserpane-${paneId}`}>
      <div className="flex items-center gap-1 border-b border-border p-1">
        <Button onClick={() => view.current?.goBack()} disabled={!canGoBack}>...</Button>
        <Button onClick={() => view.current?.goForward()} disabled={!canGoForward}>...</Button>
        <Button onClick={() => view.current?.reload()}>...</Button>
        <input
          data-testid={`browserurl-${paneId}`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const next = normaliseUrl(typed)
            if (next) view.current?.loadURL(next)
          }}
        />
      </div>
      <webview
        ref={view}
        src={address}
        partition={partition}
        className="min-h-0 flex-1"
        data-testid={`browserview-${paneId}`}
      />
    </div>
  )
}
```

Fill in the button labels, the `canGoBack`/`canGoForward` state (driven off the webview's `did-navigate` and `did-navigate-in-page` events), and the styling to match `FileView.tsx`, which is the closest existing sibling. Note the testids: none of them start with `tab-`.

The `partition` prop comes from the project: `persist:proj-${projectId}`. When `projectId` is undefined (the synthetic Unsorted project), fall back to a single `persist:proj-unsorted`, because a webview with no partition shares the default session with everything else.

React does not know the `<webview>` intrinsic element. Add the JSX declaration in this file rather than globally, so the type lives next to its only consumer.

- [ ] **Step 3: Add the branch in `App.tsx`**

Extend the existing ternary chain at `App.tsx:1659`, before the terminal fallback:

```tsx
) : box.pane.type === 'browser' ? (
  <BrowserPane
    paneId={box.pane.id}
    projectId={projectIdForTab(state.projects, box.pane)}
    url={box.pane.url}
    paneColor={box.pane.color}
  />
) : (
```

The comment above that chain currently says every pane was a terminal until the editor slice and names editor and diff. Update it, or it becomes false at this commit.

- [ ] **Step 4: Add the open path**

Beside `openFile` at `App.tsx:521`, a callback with the same shape. `opened` both adds the pane and selects it, and a browser pane founds its own tab, so the id it selects by is the tab's id, exactly as for an editor:

```tsx
const openBrowserPane = useCallback(() => {
  if (!project) return
  window.pterm
    .openBrowser(project.id)
    .then((tab) => {
      if (tab) {
        dispatch({ type: 'opened', tab })
        return
      }
      fail('Could not open a browser pane')
    })
    .catch(fail)
}, [project, dispatch, fail])
```

And a palette command in the `commands` array at `App.tsx:2238`:

```tsx
{ name: 'New browser pane', run: openBrowserPane },
```

- [ ] **Step 5: Run it and look at it**

Run: `npm start`

Open the palette with ⌘K, run `New browser pane`, type `localhost:3000` (or any dev server you have running) and press Enter. Then split the tab and confirm the browser pane resizes with the divider, switch projects and confirm it disappears and comes back, and quit and relaunch and confirm the URL is still there.

This step is a human check and it is not optional. This codebase has shipped two real defects past 1428 green tests and ten green reviews, both found only by opening the app. The gates cannot see the rendered artifact.

- [ ] **Step 6: Verify the isolation claim rather than assuming it**

With two projects open, open a browser pane in each, point both at the same page, and set a cookie or a `localStorage` key from the page in one. Confirm the other pane does not see it. If they share, the `partition` prop is not reaching the element, which is easy to do and silent.

- [ ] **Step 7: Run the suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: green. `appLayout.test.ts` and `workspace.test.ts` are the ones most likely to notice a new pane kind reaching the layout.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/renderer/BrowserPane.tsx src/renderer/App.tsx
git commit -m "Render a browser pane in a hardened webview"
```

---

### Task 5: Spike, can Playwright reach inside a webview

**Files:**
- Create: `docs/superpowers/notes/2026-08-11-playwright-webview-reach.md`
- Create: `tests/e2e/fixtures/browser-page.html`

**Interfaces:**
- Consumes: a working browser pane from Task 4.
- Produces: a recorded, measured answer that Task 9 depends on, and a fixture page.

**This task writes no production code and its deliverable is a measurement.** Do not skip it and do not guess the answer. A `<webview>` hosts an out-of-process frame, and whether it appears in `page.frames()` under Playwright's Electron driver is not something to reason about from first principles. Two of this project's worst test-quality incidents came from specs that asserted a capability the harness did not have.

- [ ] **Step 1: Write the fixture page**

Create `tests/e2e/fixtures/browser-page.html`. It needs a title, a uniquely identifiable element, and nothing else:

```html
<title>PRCLI browser fixture</title>
<h1 id="marker">browser-pane-fixture-loaded</h1>
```

A `file://` fixture rather than a spun-up server: there is no port to race on, no server to leak between runs, and no shared-socket failure mode. This project has lost time to both a shared tmux socket emptying mid-run and to ports.

- [ ] **Step 2: Write a throwaway probe spec**

Create `tests/e2e/webviewProbe.spec.ts` (deleted at the end of this task). Open a browser pane on the fixture, then try all three reach mechanisms and log what each returns:

```ts
// 1. Does the webview show up as a frame of the main window page?
console.log('frames:', page.frames().map((frame) => frame.url()))

// 2. Does Playwright treat it as a frame-owning element?
try {
  const marker = page.frameLocator('webview').locator('#marker')
  console.log('frameLocator text:', await marker.textContent({ timeout: 2000 }))
} catch (error) {
  console.log('frameLocator failed:', String(error))
}

// 3. Main-side, via the webContents the app already owns.
const text = await electronApp.evaluate(async ({ webContents }) => {
  const view = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
  if (!view) return null
  return view.executeJavaScript('document.getElementById("marker")?.textContent ?? null')
})
console.log('main-side executeJavaScript:', text)
```

- [ ] **Step 3: Run it and record what actually happened**

Run: `npx playwright test tests/e2e/webviewProbe.spec.ts --reporter=line`

Copy the real output. Do not paraphrase it and do not write down what you expected.

- [ ] **Step 4: Write the findings note**

Create `docs/superpowers/notes/2026-08-11-playwright-webview-reach.md` recording the Electron and Playwright versions, the three verbatim results, and the resulting decision:

- If mechanism 1 or 2 works, Task 9 asserts page content through it directly.
- If only mechanism 3 works, Task 9 asserts page content through `electronApp.evaluate`, and the note records that `page.frames()` and `frameLocator` were measured not to reach it.
- If none works, Task 9 asserts pane chrome only (URL bar value, error card, pane presence, persistence across relaunch) and the page-content assertion moves to an integration test.

- [ ] **Step 5: Delete the probe and commit the findings**

```bash
rm tests/e2e/webviewProbe.spec.ts
git add docs/superpowers/notes/2026-08-11-playwright-webview-reach.md tests/e2e/fixtures/browser-page.html
git commit -m "Measure how a Playwright spec can reach inside a webview"
```

---

### Task 6: Remembering where the pane got to

**Files:**
- Modify: `src/shared/ipc.ts` (`CHANNELS` near `:48`, `PTermApi` near `:1099`)
- Modify: `src/main/ipc/register.ts`, `src/preload/index.ts`
- Modify: `src/renderer/BrowserPane.tsx`, `src/renderer/lib/tabLabel.ts`
- Test: `tests/unit/tabLabel.test.ts`, `tests/integration/openBrowser.test.ts`

**Interfaces:**
- Consumes: `CHANNELS.openBrowser` and the pane component.
- Produces: `setPaneUrl(paneId: string, url: string): void`, fire and forget, on `PTermApi` and `window.pterm`.

Fire and forget over `ipcRenderer.send`, mirroring `setLayout` (`ipc.ts:48`, preload `:95`), and **debounced in the renderer**. A page redirects several times on a single navigation, and a config write per redirect thrashes `config.json` for no gain. Commit on settle, the way `setLayout` commits on pointer-up rather than during the drag.

Persist `url` only. The tab is named for the page's host including its port, and the live page title is not used.

**Revised 2026-08-11 during implementation.** This step originally said `page-title-updated` drove the label and that the live title replaced the host once the page loaded. That was a plan defect: this task's file list is `BrowserPane.tsx` and `tabLabel.ts`, while every `tabLabel` call site is in `App.tsx`, `TabBar.tsx`, `Sidebar.tsx`, `TabsPanel.tsx` and `DeadPane.tsx`, so a live title could not reach the tab bar from here at all. Put to the user, who chose host only, on the grounds that two Vite dev servers are both titled "Vite + React + TS" while their ports tell them apart. Do not add a `page-title-updated` listener.

- [ ] **Step 1: Write the failing `tabLabel` tests**

Add to `tests/unit/tabLabel.test.ts`:

```ts
it('names a browser tab by its host', () => {
  expect(
    tabLabel({ id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 'https://example.com/a/b' }),
  ).toBe('example.com')
})

it('names a browser tab on localhost by host and port, which is what tells two dev servers apart', () => {
  expect(
    tabLabel({ id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', url: 'http://localhost:5173/' }),
  ).toBe('localhost:5173')
})

it('falls back for a browser tab with no url', () => {
  expect(tabLabel({ id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser' })).toBe('demo · b1')
})

it('prefers a user title over the host', () => {
  expect(
    tabLabel({ id: 'b1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'browser', title: 'Docs', url: 'https://example.com' }),
  ).toBe('Docs')
})
```

The port is included deliberately. Two dev servers on localhost are the common case, and a label of `localhost` twice over identifies neither.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/tabLabel.test.ts`

Expected: FAIL, the browser cases return `demo · b1`.

- [ ] **Step 3: Implement the label**

In `tabLabel`, after the editor/diff branch:

```ts
if (tab.type === 'browser' && tab.url) {
  const host = hostOf(tab.url)
  if (host) return host
}
```

Parse with `new URL(...)` inside a try, and take `url.host` (which includes the port) rather than `hostname` (which does not). `about:blank` has an empty host and falls through to the terminal label, which is correct: a blank pane has no page to be named after. The existing doc comment on this function explains why the editor case takes a basename by hand rather than with `node:path`; `URL` is a web global and is available in the renderer, so the same constraint does not apply here.

- [ ] **Step 4: Add the channel, handler and preload line**

`CHANNELS`:

```ts
setPaneUrl: 'pterm:setPaneUrl',
```

`PTermApi`:

```ts
setPaneUrl(paneId: string, url: string): void
```

Handler in `register.ts`, using `.on` rather than `.handle` because nothing awaits it, and wrapped in `serialise` because it writes:

```ts
ipcMain.on(CHANNELS.setPaneUrl, (_event, paneId: string, url: string) => {
  void serialise(async () => {
    const config = await store.read()
    const pane = config.panes.find((row) => row.id === paneId)
    if (!pane || pane.type !== 'browser') return
    if (pane.url === url) return
    await store.write({
      ...config,
      panes: config.panes.map((row) => (row.id === paneId ? { ...row, url } : row)),
    })
  })
})
```

The kind check is not defensive noise. Without it, a stray call writes a `url` onto a terminal row, where `normalisePane` keeps it and nothing ever reads it.

Preload:

```ts
setPaneUrl: (paneId, url) => ipcRenderer.send(CHANNELS.setPaneUrl, paneId, url),
```

- [ ] **Step 5: Wire the component**

In `BrowserPane`, on `did-navigate` and `did-navigate-in-page`: update local address state and the URL bar immediately, and call `window.pterm.setPaneUrl` through a debounce of about 500ms. Clear the pending timer on unmount so a pane closed mid-navigation does not write after it is gone.

Do not listen for `page-title-updated` at all. See the revision note above: the live title was cut from M1, and the label comes from the persisted `url`'s host.

- [ ] **Step 6: Add the persistence test**

Add to `tests/integration/openBrowser.test.ts`:

```ts
it('setPaneUrl moves the saved url and leaves other panes alone', async () => {
  const pane = await openBrowser('p1', 'https://example.com')
  await setPaneUrl(pane!.id, 'https://example.com/deep')

  const config = await store.read()
  expect(config.panes.find((row) => row.id === pane!.id)?.url).toBe('https://example.com/deep')
})

it('setPaneUrl refuses a pane that is not a browser', async () => {
  const before = await store.read()
  await setPaneUrl(terminalPaneId, 'https://example.com')
  const after = await store.read()
  expect(after.panes).toEqual(before.panes)
})
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck`

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/register.ts src/preload/index.ts \
  src/renderer/BrowserPane.tsx src/renderer/lib/tabLabel.ts \
  tests/unit/tabLabel.test.ts tests/integration/openBrowser.test.ts
git commit -m "Remember a browser pane's page, and name its tab by host"
```

---

### Task 7: Failing without taking the pane down

**Files:**
- Modify: `src/renderer/BrowserPane.tsx`
- Test: covered by e2e in Task 9; the `-3` rule gets a unit test here

**Interfaces:**
- Consumes: the component from Task 4.
- Produces: `isRealLoadFailure(errorCode: number): boolean`, exported from `BrowserPane.tsx` so it can be tested without mounting anything.

Three failure states, all rendered inside the pane, none of which close the pane or its tab. A browser pane cannot die the way a terminal can, and the DeadPane path does not apply to it because `canHaveSession` is false.

**`errorCode === -3` (ABORTED) must not be treated as a failure.** It fires on ordinary redirects and on a load cancelled by a newer navigation, so a naive `did-fail-load` handler flashes an error card on perfectly healthy pages. This is the single most likely defect in this task.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/browserFailure.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isRealLoadFailure } from '../../src/renderer/BrowserPane'

describe('isRealLoadFailure', () => {
  it('ignores ABORTED, which fires on ordinary redirects', () => {
    expect(isRealLoadFailure(-3)).toBe(false)
  })

  it('reports a name that did not resolve', () => {
    expect(isRealLoadFailure(-105)).toBe(true)
  })

  it('reports a refused connection, which is a dev server that is not running', () => {
    expect(isRealLoadFailure(-102)).toBe(true)
  })
})
```

`-102` (CONNECTION_REFUSED) is the case a user hits daily: the dev server is not up yet. It must show, and it must offer Retry.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/browserFailure.test.ts`

Expected: FAIL, `isRealLoadFailure` is not exported.

- [ ] **Step 3: Implement and wire the three states**

Export the predicate, then render:

- `did-fail-load` where `isRealLoadFailure(errorCode)`: a card with the code, the description and a Retry button that calls `reload()`.
- `render-process-gone`: a crashed card with a Reload button. The pane and its tab survive.
- ~~`unresponsive` / `responsive`: a banner that appears and clears.~~ **Cut 2026-08-11 during implementation, deferred to M2.** `<webview>` does not emit these: its 35 `addEventListener` overloads in `electron.d.ts` include neither, and they exist on `WebContents` only. A listener would compile with a cast and never fire. Do not add one, do not cast, and do not leave a commented-out stub; the spec's Failure states section carries the full reasoning. `render-process-gone` was checked at the same time and IS on the tag, so the crash state is real.

Give each card a `data-testid` for Task 9, none beginning with `tab-`.

- [ ] **Step 4: Run to green, then look at it**

Run: `npx vitest run tests/unit/browserFailure.test.ts && npm start`

In the app, open a browser pane and navigate to `http://localhost:1` (nothing listens there). Confirm the refused-connection card appears with a working Retry. Then navigate to a URL you know redirects (any bare `http://` site that upgrades to `https`) and confirm no error card flashes during the redirect. That second check is the one that catches a missing `-3` exclusion, and no unit test can perform it.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/BrowserPane.tsx tests/unit/browserFailure.test.ts
git commit -m "Show load, crash and hang failures inside the browser pane"
```

---

### Task 8: DevTools and popup handling

**Files:**
- Modify: `src/renderer/BrowserPane.tsx`

**Interfaces:**
- Consumes: the component and its webview ref.
- Produces: nothing new to other tasks.

- [ ] **Step 1: Add the DevTools toggle**

A button in the chrome strip calling `openDevTools()` / `closeDevTools()` on the webview, with its state driven by `isDevToolsOpened()`. Electron opens a webview's DevTools in a detached window by default, which is the right behaviour here: the pane is often narrow, and docking DevTools inside it would leave neither usable.

- [ ] **Step 2: Deny popups, navigate in place instead**

On the webview's underlying contents, deny `window.open` and `target=_blank` from opening an OS window, and navigate the pane to the requested URL instead. From the renderer this is the `new-window` path on the webview element; confirm against the Electron 43 typings which form is current, rather than copying an older recipe.

A denied popup that does nothing at all is worse than either alternative: the user clicks a link and the app appears broken.

- [ ] **Step 3: Check both by hand**

Run: `npm start`

Open DevTools on a page and confirm Elements and Console work against the page (not against PRCLI's own renderer, which is the mistake to watch for). Then click a `target=_blank` link and confirm the pane navigates rather than spawning a window.

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/BrowserPane.tsx
git commit -m "Open DevTools against the page, and keep popups in the pane"
```

---

### Task 9: End to end

**Files:**
- Create: `tests/e2e/browser.spec.ts`

**Interfaces:**
- Consumes: everything above, and the decision recorded in Task 5's findings note.
- Produces: the feature's e2e coverage.

**Read `docs/superpowers/notes/2026-08-11-playwright-webview-reach.md` before writing a line of this.** Which assertions are available is a measured fact recorded there, not a choice to make now.

Model the file on `tests/e2e/editorRestore.spec.ts`, which is the closest sibling: it covers a sessionless pane across a relaunch, which is most of what this needs.

- [ ] **Step 1: Write the spec**

Cover:

1. The palette command opens a browser pane, and the pane's chrome is present.
2. Typing a `file://` URL for `tests/e2e/fixtures/browser-page.html` and pressing Enter loads it. Assert page content by whichever mechanism Task 5 measured to work; if none did, assert the URL bar's value and the tab's label instead, and say so in the test's own header.
3. The URL survives `app.close()` and relaunch. This is the `attachSavedFields` and `mergeSessionlessPanes` regression, and it is the highest-value test in the file.
4. A browser pane splits beside a terminal and both are laid out. Assert on the two boxes' widths, not on `toBeVisible`.
5. Navigating to `http://localhost:1` shows the failure card with a Retry button.

- [ ] **Step 2: Guard against the two known e2e traps**

Before running: confirm no new `data-testid` in the spec or the component starts with `tab-`, and confirm no assertion is an auto-retrying matcher against a value that already held before the action. Where you need to wait for a navigation, wait on something the navigation must change (the URL bar's value, the tab label), never on something that was already true.

- [ ] **Step 3: Run the spec alone, then the whole suite**

Run: `npx playwright test tests/e2e/browser.spec.ts --reporter=line`

Then: `npm run e2e`

Expected: green. If the full run is red where the single file was green, suspect ordering and shared state before suspecting the feature. Note that a failing test causes Playwright to requeue the rest of its file against a fresh app, so one real failure can present as several.

- [ ] **Step 4: Prove at least one assertion discriminates**

Pick the relaunch test. Delete the `url` line from `attachSavedFields` and re-run just that test.

Expected: it fails. Restore the line, confirm `git diff src/main/ipc/savedFields.ts` is empty, re-run to green, and record the measured result in the spec's header. If it passes with the line deleted, the test is passing for a different reason than you think, which is exactly the situation `savedFields.test.ts`'s own header documents for `filePath`.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/browser.spec.ts
git commit -m "Cover the browser pane end to end"
```

---

### Task 10: Close out M1

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-browser-pane-design.md` (acceptance checklist only)

- [ ] **Step 1: Walk the spec's M1 acceptance list against the running app**

Run: `npm start`, and check each line of the spec's "M1 acceptance" section by hand:

- Opens from ⌘K into the active project.
- Splits, resizes, drag-to-splits like any other pane.
- Switching projects hides and reveals it with the page still loaded.
- Two projects on one localhost port do not share cookies or `localStorage`.
- `localhost:3000` reaches the dev server over http.
- The URL survives relaunch; the tab shows the host.
- A failed load and a crashed renderer each show a recoverable card. The hung-page banner was cut on 2026-08-11 and deferred to M2; see Task 7.
- DevTools opens against the page.

Report exactly which passed and which did not. Do not report a line as passing that you did not perform.

- [ ] **Step 2: Full gates**

Run: `npm test && npm run typecheck && npm run e2e`

- [ ] **Step 3: Commit any acceptance-note updates**

```bash
git add docs/superpowers/specs/2026-08-11-browser-pane-design.md
git commit -m "Record M1 acceptance results"
```

---

## Self-Review

**Spec coverage.** Every M1 requirement maps to a task: type and `SESSIONLESS` (1), `url` on both records and its three validation sites (1), `savedFields` (1), `stateForOpen` (1), `openBrowser` with its no-dedupe difference (3), the mandatory tab row (3), per-project partition (4), `webviewTag` plus all three hardening measures (4), URL normalising (2), navigation persistence debounced (6), host-drives-label and url-only-persisted (6), the `-3` exclusion and the two buildable failure states (7; the third was cut, see Task 7), DevTools (8), popup handling (8), the `file://` fixture (5), the Playwright spike with both branches (5, 9), and the acceptance list (10).

**Placeholders.** The one deliberate under-specification is Task 9's assertion mechanism, which is a measured input from Task 5 rather than a gap. Task 4 leaves button labels and styling to the implementer, which is a matching-the-codebase judgement, not a missing decision.

**Type consistency.** `normaliseUrl` is used under that name in Tasks 2, 3 and 4. `isRealLoadFailure` is defined and consumed in Task 7 only. `openBrowser(projectId, url?)` and `setPaneUrl(paneId, url)` keep the same signatures across `CHANNELS`, `PTermApi`, the handler, the preload and the tests. `url` is the field name in `TabDescriptor`, `PaneRecord`, `attachSavedFields`, `normalisePane` and `tabLabel` alike.

**Out of scope, restated.** No CDP, no MCP server, no dev-server URL auto-detect, no device-width presets, no global or detached pane. Those are M2 and M3 and each needs its own brainstorm.
