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

Entry points: a `⌘K` command and an item in the tab-bar `+` menu, both
carrying the active `projectId`.

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

`page-title-updated` drives the tab label via a new case in
`src/renderer/lib/tabLabel.ts:34`. Only `url` is persisted, never the title. On
relaunch the tab shows the hostname until the page loads and the live title
replaces it. One saved field, and no stale title to invalidate.

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
- `unresponsive`: a banner. No automatic kill.

## Security

`webviewTag: true` widens the main window's webPreferences, which is currently
`contextIsolation: true, nodeIntegration: false`
(`src/main/index.ts:490-493`). The mitigations belong in M1, not in a
follow-up:

- A `will-attach-webview` handler in main that strips any `preload` and
  rejects unexpected webPreferences. This is the documented hardening step and
  the reason the widened surface is acceptable.
- `allowpopups` off, and a `setWindowOpenHandler` that denies OS windows so
  `target=_blank` navigates in place.
- A permission handler on each partition's session denying camera, microphone,
  geolocation and notifications by default.

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

- A browser pane opens from `⌘K` and from the tab-bar `+` menu, into the
  active project.
- It splits, resizes, and drag-to-splits like any other pane.
- Switching projects hides it and switching back reveals it, with the page
  still loaded.
- Two projects on the same localhost port do not share cookies or
  `localStorage`.
- Typing `localhost:3000` reaches the dev server over http.
- The URL survives a relaunch; the tab shows the hostname, then the title.
- A failed load, a crashed renderer and a hung page each show a recoverable
  card, and the pane survives all three.
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
