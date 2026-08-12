# A browser button that knows where your dev server is

**Date:** 2026-08-12
**Status:** Design, approved
**Follows:** `2026-08-12-browser-mcp-design.md` (the browser pane and its MCP bridge, shipped in 0.4.0)

## What this is

One button in the terminal column's tab bar. Pressing it opens a browser pane on
the project's running dev server, or a blank one when there is nothing to open.

The feature exists because the path today is: notice the port your server printed,
open a browser pane by hand, type `localhost:5173`. The app already sees that port
go by. It should remember it.

## Decisions

Four were taken by the user during design and are not open questions.

1. **The button always opens a pane.** With a detected server it lands on that URL,
   without one it opens blank. Detection is a bonus, never a precondition, so the
   button is never disabled and never guesses a port nobody announced.
2. **The port is learned by watching terminal output.** Dev servers announce
   themselves. That announcement is the server's own statement of where it is,
   which is stronger evidence than any inference from `package.json`, and it needs
   no new dependency and no polling.
3. **When several servers are running in one project, the most recently announced
   wins.** It is almost always the one just started and about to be looked at, and
   pressing again after restarting the other one switches to it. No picker.
4. **Every press opens a new pane.** No reuse rule, no decision about which pane
   counts as current.

## How detection works

`SessionManager` already delivers every pty's output to main through `onData`.
The scanner watches that stream. It is a pure function over a chunk plus a small
per-pane tail, so it can be tested without a pty.

Three mechanics carry the risk, and each is a test rather than an assumption.

**ANSI codes sit inside the URL.** Vite prints the port wrapped in escape
sequences, so the visible text `http://localhost:5173/` arrives as bytes with
`\x1b[1m` between the colon and the digits. Matching the raw stream yields
`http://localhost:` and loses the port, which is the failure mode that would make
this feature look broken while every naive test passed. The scanner strips ANSI
before matching, and a test feeds it a real Vite-shaped line.

**A URL can straddle two chunks.** Pty output arrives in arbitrary pieces. The
scanner keeps a short tail per pane and scans tail plus chunk, so a URL split
across the boundary is still found once.

**Only loopback counts.** The scanner reuses `isLoopbackUrl` from
`src/shared/localOrigin.ts`. There is one loopback predicate in this codebase and
this feature does not add a second. A server announcing a public URL is not a dev
server worth opening for, and admitting one here would hand the browser pane an
origin the rest of the system is built to refuse.

## What is remembered, and for how long

Per project: the most recently announced loopback URL, and the id of the pane that
announced it.

**Runtime only.** The record lives in main's memory and is never persisted. A URL
from a previous run is a lie the moment the server is gone, and a persisted one
would open a dead port on the next launch, which reads as the feature being
broken rather than the server being down. The entry is dropped when the pane that
announced it dies, for the same reason.

When the remembered server has since stopped, the pane shows the browser's own
connection-refused page. That page is accurate and familiar, and inventing a
prettier one would only hide which port was tried.

## The interfaces this touches

- **`TabBar`** gains an optional `onOpenBrowser` prop, rendering the button only
  when it is given. `TabBar` is shared: the terminal column passes the prop, the
  browser column does not.
- **`openBrowser(projectId)`** gains an optional URL. It already stores
  `about:blank` when given nothing, so the no-server case needs no new path.
- **A channel** for the renderer to ask main what URL a project has, if any.

## Edge cases worth naming

- **The button's testid must not begin with `tab-`.** More than 27 e2e locators
  count tabs with `[data-testid^="tab-"]`, and an element under that prefix
  inflates every one of those counts while every assertion still passes.
- **The button costs horizontal pixels in the terminal bar.** `splits.spec.ts`
  encodes the chrome width as a pixel budget, and a previous column addition broke
  five of its tests on leftover terminal width alone. That spec runs before this
  lands.
- **A server that restarts on the same port** re-announces, which simply refreshes
  the timestamp. Nothing special is needed.
- **A pane running a server that prints nothing** is invisible to this feature, by
  construction. The button still opens a blank pane.

## Testing

- **Unit, the scanner:** a Vite-shaped ANSI-wrapped line yields the right port; a
  URL split across two chunks is found once; a non-loopback URL is ignored; the
  most recent of several wins.
- **Integration:** main records a URL from a driven pty stream and drops it when
  the pane dies.
- **E2E:** the button is present in the terminal bar and absent from the browser
  bar; pressing it opens a pane; pressing it after a pane announced a URL opens on
  that URL; `splits.spec.ts` still passes.

Every check whose success looks like absence (no button in the browser bar, no URL
recorded for a public origin) must be shown to fail against a known violation
before its silence counts as evidence.

## Out of scope, deliberately

- **Port scanning with `lsof`.** It would catch servers pTerm never saw start, at
  the cost of a shell-out per press, fiddly pid-to-cwd matching, and picking up
  unrelated servers in the same tree. Revisit only if watching output proves to
  miss the common case.
- **Guessing from `package.json`.** A guess that is right half the time is worse
  than a blank pane, because it looks like a bug rather than an absence.
- **A picker when several servers are running.** Rule 3 settles it without UI.
- **Reusing an existing browser pane.** Every press opens a new one.
- **Device widths and responsive presets.** Named in the M3 roadmap, unrelated to
  this button.
