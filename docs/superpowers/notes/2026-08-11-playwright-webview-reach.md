# Can a Playwright spec reach inside a `<webview>`

Measured 2026-08-11, on Electron 43.2.0 and Playwright 1.62.0 (`npx
playwright --version`, `node_modules/electron/package.json`), against
`master` at commit `9390dbf961d2da526d7fc409758381566111e9c4`.

## Setup

A throwaway spec, `tests/e2e/webviewProbe.spec.ts` (deleted before this
task's commit), seeded one browser pane directly into `config.json` (project
row with `slug`, one `panes` row of `type: 'browser'` pointing its `url` at
`tests/e2e/fixtures/browser-page.html` via a `file://` URL, and a matching
`tabs` row), launched through the shared `launchApp` harness, waited for
`[data-testid="browserview-b1"]` to appear, and then ran all three
mechanisms against that one pane.

`tests/e2e/fixtures/browser-page.html` is a two-line fixture: a `<title>`
and `<h1 id="marker">browser-pane-fixture-loaded</h1>`. It is a real
deliverable of this task, committed alongside this note, and Task 9 loads
the same file.

## Probe 1: `page.frames()`

```
frames: [
  'file:///Users/paolo/Code/PRCLI/.vite/renderer/main_window/index.html',
  'about:blank'
]
```

The webview's guest DOES show up as a second entry in `page.frames()`, but
its `url()` reports `about:blank`, never the fixture's real `file://` URL.
Confirmed as reported, not usable for a content assertion: there is no way
to pick out "this frame is the b1 pane's guest" from the list, let alone
assert what it loaded.

## Probe 2: `page.frameLocator(...)`

Redone with a selector scoped to the one seeded pane,
`page.frameLocator('[data-testid="browserview-b1"]').locator('#marker')`,
with only one browser pane mounted so the earlier strict-mode violation
could not recur. It failed anyway, with a different and more decisive
error:

```
frameLocator failed: Error: locator.textContent: Error: Selector "[data-testid="browserview-b1"]" resolved to <webview class="min-h-0 flex-1" partition="persist:proj-p1" data-testid="browserview-b1" src="file:///Users/paolo/Code/PRCLI/tests/e2e/fixtures/browser-page.html"></webview>, <iframe> was expected
Call log:
  - waiting for locator('[data-testid="browserview-b1"]').contentFrame().locator('#marker')
```

This is not a strict-mode ambiguity (there was exactly one match) and not a
selector mistake (the selector found the right element, by its own testid,
carrying the right `src`). Playwright's `contentFrame()` rejects the match
outright because it is a `<webview>` element, not an `<iframe>`. This reads
as a hard capability limit under this Playwright version, not something a
different selector would route around.

## Probe 3: main-side, via `electronApp.evaluate`

```
main-side executeJavaScript: browser-pane-fixture-loaded
```

Matches the team lead's earlier result exactly: `webContents.getAllWebContents()`
finds the guest, `getType() === 'webview'` picks it out, and
`executeJavaScript` on it returns the fixture's real marker text.

## Decision for Task 9

Only mechanism 3 works. Task 9 must assert page content through
`electronApp.evaluate(({ webContents }) => ...)`, filtering
`getAllWebContents()` by `getType() === 'webview'` the way this probe and
the team lead's earlier probe both did. With more than one browser pane
mounted (recall: every pane stays mounted regardless of which project is
active), `.find(...)` is not enough to pick out a specific pane; Task 9
will need a way to disambiguate the right guest (for example, matching on
which pane's `partition` or which pane's current `src`/`getURL()` is
expected), which this task did not need to solve because ONE browser pane
was mounted throughout.

`page.frames()` and `page.frameLocator(...)` were both measured, not
assumed, to be unusable for page-content assertions: `frames()` lists the
guest but reports its URL as `about:blank` always, and `frameLocator`
throws because a `<webview>` is not an `<iframe>` as far as
`contentFrame()` is concerned. Chrome/pane-level assertions (URL bar value,
error card, pane presence, persistence across relaunch) remain reachable
through the ordinary `page.getByTestId(...)` route on the pane's own DOM
(the back/forward/reload buttons, the address `<input>`, the pane's own
`browserpane-${paneId}` wrapper) since none of that is inside the guest.
