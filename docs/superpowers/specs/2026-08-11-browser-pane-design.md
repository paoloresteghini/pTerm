# An embedded browser pane, scoped to a project: design

Date: 2026-08-11

Looking at something together (a dev server, a rendered page, a bug on a
staging URL) currently means leaving the app. This adds a browser as a pane
type, so a page sits beside the terminals in the same split, belongs to the
project that opened it, and follows the project when you switch.

The user's stated constraint, consistent with how issues, notes and skills
already work: **project-scoped by default, global only when explicitly
detached.**

## Two premises checked before designing

**Chrome Web Store extensions cannot run here.** Electron loads unpacked
extensions with a partial `chrome.*` surface. React DevTools and Redux
DevTools work. Claude for Chrome does not. The original idea assumed
extensions were the route to Claude controlling the page, so the premise
mattered: it is not, and the alternative is better. An embedded Chromium
view exposes the Chrome DevTools Protocol directly, which gives Claude a
handle on *that project's* pane rather than on whatever window happens to be
frontmost. Extensions are dropped from scope.

**The APIs exist in the pinned Electron.** Verified against
`node_modules/electron/electron.d.ts` at 43.2.0, not from memory:
`WebviewTag` (:19631), `WebContentsView` (:18636),
`webview.getWebContentsId()` (:19949), `webContents.fromId` (:15921),
`debugger.attach` / `sendCommand` (:7590, :7606). The control chain is
therefore: renderer webview gives an id, main resolves it to a `WebContents`,
main attaches the debugger. No remote debugging port is opened.

## Where a browser pane fits

The app already has the concept this needs. `TabType`
(`src/shared/ipc.ts:144`) is `'claude' | 'preset' | 'shell' | 'editor' |
'diff'`, and the load-bearing split is not terminal-versus-not, it is
`SESSIONLESS` (`:166`): `editor` and `diff` have no tmux session at all.
`canHaveSession` (`:170`) is consulted everywhere a pane's liveness matters.

A browser is the third sessionless kind. Adding it to that list is the single
most important line in this design, because the list's own doc comment says a
kind missing from it is silently written away on relaunch.

Layout is pure renderer-side CSS flex. `FileView` and `Terminal` render into
identical boxes sized by `flexBasis` from `boxesOfRow`
(`src/renderer/workspace.ts:604`), and there is no separate path for
non-terminal panes. A browser pane rendering `h-full w-full` in that same slot
inherits splits, ratios, dividers, drag-to-split and tab switching without any
of them knowing it exists.

## Approaches for hosting the page

**A. `<webview>` tag.** A DOM element inside the existing pane box.
Participates in the flex layout, in `visibility: hidden` tab switching, and in
the divider overlay, all with zero geometry plumbing. `partition="persist:..."`
gives per-project cookie jars as an attribute. `getWebContentsId()` hands main
the handle the debugger needs. Costs: Electron labels webview "not
recommended", it has focus quirks, and it requires `webviewTag: true` on the
main window. **Chosen.**

**B. `WebContentsView`.** Electron's blessed API, and the wrong shape here. It
is an OS-level layer positioned by absolute rect from main, so every resize,
tab switch, divider drag, split and sidebar toggle becomes a geometry push
over IPC. Worse, it composites above all DOM: the command palette, modals,
dropdowns and `PaneDivider` would be painted over by the page. In an app this
overlay-heavy that is a permanent tax, not a one-time cost. Rejected.

**C. `<iframe>`.** Cheapest and immediately fatal. Most sites send
`X-Frame-Options` or a frame-ancestors CSP. No separate session, no DevTools,
no CDP. Rejected.

The seam is one branch in the `App.tsx:1659` ternary, so if Electron ever does
remove the webview tag, the component behind that branch is the only thing
that changes.

## Scope: three milestones

The whole idea is too large for one plan, and the pieces have clean seams.

**M1, the pane.** A `'browser'` pane type that renders a page, navigates,
keeps a per-project cookie jar, opens DevTools, and survives relaunch. Useful
on its own. This spec covers M1 in full.

**M2, Claude control.** Main attaches `debugger` to the pane's webContents.
PRCLI exposes an MCP server whose browser tools are scoped to the calling
project's pane, and Claude sessions that PRCLI spawns get it wired
automatically. A new subsystem with its own risk (transport, tool schemas,
per-project config injection). Depends only on M1 existing. Sketched below.

**M3, dev polish.** Dev-server URL auto-detected from that project's terminal
output, device-width presets, and the global/detached pane flag. All additive.
Sketched below.

# M1: the pane

## Type and persistence changes

Add `'browser'` to `TabType` (`src/shared/ipc.ts:144`) **and** to `SESSIONLESS`
(`:166`).

Add `url?: string` to `TabDescriptor` (`ipc.ts:283`) and `PaneRecord`
(`src/main/sessions/manager.ts:14`). Then, because the manager cannot derive
it, three places must all agree or the field is lost:

- `TAB_TYPES` and `normalisePane` in `src/main/state/store.ts:130` and
  `:132-160`, which validate what may be read back from disk.
- `isPane` (`store.ts:127`), which today accepts a row with no `tmuxSession`
  only for `editor` and `diff`. Without `browser` there, every saved browser
  row is dropped at load.
- `attachSavedFields` (`src/main/ipc/savedFields.ts`), whose doc states that
  anything the manager cannot derive belongs in its map. Omitting it is the
  exact failure where a config-only pane field vanishes on relaunch while
  everything else about the pane restores correctly.

`stateForOpen` (`src/main/status/machine.ts:105`) gets a null case, as the
other sessionless kinds have.

## Opening

New handler `openBrowser` in `src/main/ipc/register.ts`, cloned from
`openEditor` (`:1978`) with its documented differences, as `openDiff`
(`:2063`) already does. It resolves the project from `projectId`, mints an id
with `newSessionId()`, and writes **both** the `PaneRecord` and a `TabRow`
`{ id, groupId: id, activePaneId: id, layout: { dir: 'row', ratio: [1], kids:
[id] } }` in a single `store.write`. The tab row is mandatory:
`mergeSessionlessPanes` (`src/main/ipc/sessionlessPanes.ts:54`) drops any
sessionless pane that no tab row names.

The one documented difference from `openEditor`: **no dedupe.** `openEditor`
returns the existing pane when one already shows that file. Two browser panes
on the same URL is a legitimate thing to want (two viewport widths, two routes
of the same app), so `openBrowser` always creates.

Entry point: a `⌘K` command carrying the active `projectId`.

This originally also named "an item in the tab-bar `+` menu". No such menu
exists: `+` is a single button (`TabBar.tsx:364-371`) whose click creates a
terminal. See the M1 acceptance section for why M1 ships the palette command
alone.

The four coordinated IPC edits follow the existing pattern: a `CHANNELS` entry
(`ipc.ts:7-97`), a method on `PTermApi` (`:913`), the `ipcMain.handle` wrapped
in `serialise` because it writes config, and one line in
`src/preload/index.ts`.

## Per-project isolation

The webview carries `partition={"persist:proj-" + projectId}`. Electron keys
the cookie jar, localStorage and cache off the partition name and stores them
under userData, so isolation needs no code and no cleanup path.

This is not cosmetic. Two projects both serving `localhost:3000` would
otherwise share cookies, `localStorage` and service workers, which produces
bugs that look like application bugs.

## Navigation and labelling

Navigation state is renderer-local. `did-navigate` updates local state, then a
debounced fire-and-forget `setPaneUrl` informs main, mirroring how `setLayout`
is committed on pointer-up rather than during the drag. Writing config on
every navigation event would thrash `config.json` on every redirect.

The tab is named for the page's **host, including the port**, via a new case in
`src/renderer/lib/tabLabel.ts:34`. Only `url` is persisted, and the live page
title is not used at all.

Revised 2026-08-11, during implementation. This section originally said
`page-title-updated` drove the label and that the live title replaced the host
once the page loaded. Two things came out of building it. First, the plan
allocated only `BrowserPane.tsx` and `tabLabel.ts`, while every `tabLabel` call
site lives in `App.tsx`, `TabBar.tsx`, `Sidebar.tsx`, `TabsPanel.tsx` and
`DeadPane.tsx`, so a live title could not reach the tab bar without lifting
per-pane state the way `dirtyPanes.ts` does for the dirty indicator. Second, and
the reason the answer is not simply "do that work": the page title is worse than
the host for this app's purpose. Two Vite dev servers are both titled "Vite +
React + TS", so two projects would get identical tabs, while `localhost:5173`
and `localhost:3000` identify them exactly. The port is the whole point.

`about:blank` has an empty host and falls through to the terminal-style
`slug · id` label, which is correct: a pane showing nothing has no page to be
named after. A title the USER sets by renaming the tab still wins over the host,
as it does for every other pane kind.

Chrome for the pane: back, forward, reload, hard-reload-ignoring-cache, an
editable URL bar, and a DevTools toggle.

## URL normalising

A pure function, table-driven, and the one place a daily papercut lives:

| Input | Result |
|---|---|
| `localhost:3000` | `http://localhost:3000` |
| `127.0.0.1:8080` | `http://127.0.0.1:8080` |
| `example.com` | `https://example.com` |
| `http://x/y` | unchanged |
| `about:blank`, `file://...` | unchanged |

Defaulting bare hosts to `https` is right for the web and wrong for every dev
server, so localhost and loopback literals are special-cased to `http`. Get
this backwards and every URL you type by hand fails on TLS.

## Failure states

All shown inside the pane. None of them close the pane or the tab.

- `did-fail-load`: an error card with the code, the description and a Retry
  button. **`errorCode === -3` (ABORTED) must be ignored.** It fires on
  ordinary redirects and cancelled loads, so treating it as a failure flashes
  an error card on healthy pages.
- `render-process-gone`: a crashed card with Reload. The pane and tab survive.
A hung page was originally a third state here, a banner driven by
`unresponsive` and `responsive`. **Cut from M1 on 2026-08-11 during
implementation, and deferred to M2.** Measured, not assumed: extracting every
`addEventListener` overload from `WebviewTag` in `electron.d.ts` yields 35
events and neither `unresponsive` nor `responsive` is among them. They exist
on `WebContents` and `BrowserWindow` only. `render-process-gone` IS on the tag,
so the crash state above is real; `crashed` is absent, so there is no legacy
fallback.

Reaching those events from a pane therefore needs a cross-process bridge:
`getWebContentsId()` in the renderer, main listening on
`webContents.fromId(id)`, forwarding over a channel keyed to the pane, with
cleanup when the pane closes. M2 builds main-side `webContents` access anyway
so Claude can drive the pane over CDP, and the hung-page bridge falls out of
that work. Building it here would mean bespoke plumbing that M2 then has to
adopt or replace.

## Security

`webviewTag: true` widens the main window's webPreferences, which is currently
`contextIsolation: true, nodeIntegration: false`
(`src/main/index.ts:542-548`). The mitigations belong in M1, not in a
follow-up:

- A `will-attach-webview` handler in main that strips any `preload` and
  forces `nodeIntegration`, `contextIsolation` and `webSecurity` to safe
  values regardless of what the `<webview>` requested. This is the
  documented hardening step and the reason the widened surface is
  acceptable.
- `allowpopups` forced ON, and a `setWindowOpenHandler` that denies every
  window request, navigating the pane in place instead.

  **Reversed 2026-08-11 during implementation, deliberately and measured.**
  This originally read "`allowpopups` off". Stripping the attribute did block
  OS windows, but it blocked them so early that `setWindowOpenHandler` was
  never consulted at all: a `target=_blank` click did nothing, silently, and
  the handler written to navigate in place was dead code. Measured by
  replacing the handler with a recording probe, which logged zero invocations
  for both a link click and an explicit `window.open`. Electron also derives
  `webPreferences.disablePopups` from the DOM attribute before
  `will-attach-webview` runs, so `params.allowpopups` alone does not reach it
  and `disablePopups` is forced off beside it through a cast.

  The no-OS-window guarantee therefore lives in the handler, which returns
  `{ action: 'deny' }` on every path including an unparseable URL, a
  non-http scheme, and a throwing `loadURL`. That is stronger than the
  attribute it replaced: the guarantee is now typed, documented code rather
  than an attribute, and if a future Electron drops the undocumented
  `disablePopups` field the failure mode is popups going dead again, not a
  window escaping. `tests/e2e/browser.spec.ts` guards it.
- Both permission handlers on each partition's session, denying by default:
  `setPermissionRequestHandler` for access requests (camera, microphone,
  geolocation, notifications) and `setPermissionCheckHandler` for the
  synchronous check path.

  The check handler is the broader of the two and was added after the
  whole-branch review. Electron's default check behaviour is permissive for
  some permissions, so denying it also affects things no one asked about:
  `navigator.permissions.query` results, media device labels, and most
  likely `navigator.clipboard.writeText()` for pages inside a pane. That
  follows this section's stated intent of denying everything outright, and
  it was NOT measured. If a page inside a browser pane cannot write to the
  clipboard, this is why, and it is a choice rather than an accident.

The webview itself runs with node integration off and context isolation on,
and M1 installs no preload into it.

## Testing

**Unit.** The URL normaliser as a table (this is where the papercut dies), the
`tabLabel` browser case, `normalisePane` accepting a valid browser row and
rejecting a malformed one, and `attachSavedFields` carrying `url` through.

**Integration.** `openBrowser` writes both the pane record and the tab row in
one write. `mergeSessionlessPanes` preserves a browser pane across a simulated
restore: that is the regression where a config-only field survives but the
pane does not, and it is cheap to catch here.

**E2E.** The fixture is a `file://` page, not a spun-up server, so there is no
port to race on and no shared-socket failure mode. New testids must not begin
with `tab-`: more than 27 existing locators count tabs by that prefix and a
new per-tab testid under it inflates every count. Assertions check geometry
and content rather than `toBeVisible` alone, since an element painted behind
another still passes visibility.

**One unknown, deliberately not guessed.** Whether Playwright can reach inside
a `<webview>` from the Electron main window is unverified. It is an
out-of-process frame and may not appear in `page.frames()`. The plan opens
with a short spike on exactly that:

- If it works, E2E asserts page content directly.
- If it does not, E2E asserts the pane chrome only (URL bar value, error card,
  pane presence, persistence across relaunch) and page-content assertions move
  to an integration test driving CDP.

M1 is testable either way, but the plan must not be written assuming an
answer.

## M1 acceptance

- A browser pane opens from the `⌘K` palette command "New browser pane", into
  the active project.

  **Corrected 2026-08-11 during implementation.** This originally also promised
  the tab-bar `+` menu. There is no such menu: `+` is a single button
  (`TabBar.tsx:364-371`, `onClick={onNew}`, `aria-label="New terminal"`) that
  creates a terminal directly. Turning it into a menu would change a one-click
  action every existing user relies on, which is a UX decision rather than part
  of adding a pane type, so M1 ships the palette command alone.
- It lives in a split and is laid out exactly as a terminal or editor pane is,
  sharing the same flex box, ratios and dividers.

  **Corrected 2026-08-11 during implementation.** This line originally read
  "it splits, resizes, and drag-to-splits like any other pane", which
  over-claimed. A split cannot be INITIATED from a browser pane: `splitActive`
  in `App.tsx` requires `paneGrid(activePaneId)`, and `paneGrid` is exported
  from `Terminal.tsx`, so only a mounted xterm ever registers one.
  `CHANNELS.splitPane` likewise throws for a pane `SessionManager` never
  registered. That is not a browser-pane defect and not a regression: editor
  and diff panes have always behaved the same way, for the same reason, and
  drag-to-split was already scoped to terminal panes with tmux groups. A
  browser pane inherits the sessionless kinds' constraints exactly as intended,
  which is the point of making it the third one.
- Switching projects hides it and switching back reveals it, with the page
  still loaded.
- Two projects on the same localhost port do not share cookies or
  `localStorage`.
- Typing `localhost:3000` reaches the dev server over http.
- The URL survives a relaunch, and the tab is named for the page's host and port.
- A failed load and a crashed renderer each show a recoverable card, and the
  pane survives both. A hung page is not covered: see Failure states, it is
  deferred to M2.
- DevTools opens against the page.

# M2: Claude control (sketch, not yet designed)

Main resolves the pane's `webContents` via `getWebContentsId()` and attaches
`debugger`, so no remote debugging port is opened. A port would expose PRCLI's
own UI to anything that connects, and would make target selection manual.

PRCLI exposes an MCP server with tools along the lines of `browser_navigate`,
`browser_click`, `browser_snapshot`, `browser_console` and `browser_network`,
each scoped to the browser pane of the project that the calling session
belongs to. Claude sessions spawned by PRCLI get it configured automatically,
which is the whole point: a Claude pane in a project can drive that project's
browser without being told which target to pick.

Open questions for M2's own brainstorm: transport and lifetime of the server,
what happens when a project has zero or several browser panes, how a snapshot
is represented, and whether tool calls should be visible in the pane's UI as
they happen.

# M3: dev polish (sketch, not yet designed)

**Dev-server URL auto-detect.** PRCLI already owns the terminals, so it can
recognise a `Local: http://localhost:5173` line in the same project's output
and offer it. No standalone browser can do this. Needs its own thinking about
scanning scrollback, matching the several formats dev servers print, and
whether detection offers or navigates.

**Device widths.** Presets and a drag handle that constrain the page's
viewport independently of the pane's actual pixel width.

**Global pane.** A flag that makes one browser pane appear in every project
rather than only its own, staying in the main window. The app is
single-window by design (a second instance focuses the existing one), so
popping out to a separate OS window is explicitly not this, and is not
planned.
