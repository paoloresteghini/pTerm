# Browser MCP: giving a Claude pane control of its project's browser

**Date:** 2026-08-12
**Status:** design approved, not implemented
**Follows:** `2026-08-11-browser-region-design.md` (the browser column, shipped),
`2026-08-11-browser-pane-design.md` (M1, shipped in 0.3.9), whose "M2: Claude
control" sketch this replaces.

## Problem

PRCLI owns both halves of the loop and connects neither. A Claude session runs
in a pane; the app it is editing runs in a browser pane two columns over. To
check its own work, Claude has to ask the user what the page did.

The M1 spec sketched an answer and left four questions open: transport and
lifetime of the server, what happens when a project has zero or several browser
panes, how a snapshot is represented, and whether tool calls should be visible.
This document answers all four.

## What this builds

An MCP server, exposed to the Claude sessions PRCLI already spawns, with tools
that drive a browser pane belonging to the calling session. The tool surface is
deliberately modelled on Claude in Chrome's, which is proven in daily use.

Decisions taken during brainstorming, each with the reason it beat its
alternative:

- **Claude drives its OWN pane, not the user's.** The point of the browser
  living in this window is that the user can watch it; an agent that steals
  their scroll position is worse than one with its own tab. Rejected: driving
  the visible pane (they fight over one page), and a headless target (nothing to
  watch, only what the agent reports).
- **The pane is created lazily and survives as an ordinary pane.** The pane is
  the record of what the agent did and the thing the user will want to poke at
  afterwards. Rejected: dying with the session (the page vanishes from under the
  user), and an explicit `browser_open` (a round trip, and a tool the model can
  forget).
- **Full control, confined to the project's own dev server.** The use case is
  checking work on a dev server, and confinement turns "an agent with your
  cookies" from something to trust into something the code prevents. Rejected:
  read-only (cannot drive a login flow, which is most of what checking work
  means), and unconfined (the pane's cookie jar can hold real logged-in
  sessions).
- **An accessibility tree for acting, a screenshot on request.** Cheap tool for
  the loop, expensive tool only when the question is genuinely visual.
- **Tool calls are visible in the pane** as a strip naming the last call, so a
  misbehaving loop is obvious at a glance. Rejected: invisible (the agent's
  actions are indistinguishable from the page's own behaviour), and a full
  per-pane history (the durable record is Claude's own transcript, already on
  screen beside it).

## Architecture

### Transport and routing

The hooks subsystem is the template, and it solved this problem once already.

- A stdio bridge script, `~/.pterm/bin/pterm-mcp`, installed the way
  `pterm-hook` is (`src/main/hooks/install.ts`) and registered once in the
  user's Claude configuration. Claude Code spawns it per session; it speaks MCP
  on stdin and stdout and forwards to PRCLI over a unix socket beside the hook
  socket.
- It inherits the hook server's hard-won constraints, which are documented in
  `src/main/hooks/server.ts` and are not to be rediscovered: the 104-byte
  `sun_path` ceiling measured on this machine, the connect-probe that
  distinguishes a stale socket file from a live second process, the line-length
  and buffer caps for an untrusted peer, and relocation through
  `PTERM_CONFIG_DIR` so a test never touches the user's real socket.
- **Routing needs no protocol.** Every session's tmux environment already
  carries `PTERM_TAB_ID` (`src/main/sessions/manager.ts`), so the bridge reads
  its own environment and sends that id with each call. Main maps pane id to
  project, and project to the session's browser pane.
- **Outside PRCLI the server disables itself.** With no `PTERM_TAB_ID` the
  bridge advertises zero tools and says why. A user-scoped registration
  therefore cannot leak browser control into an unrelated Claude session.

**The registration is user-scoped, and that is a tradeoff rather than an
oversight.** Writing to the user's Claude configuration is what the hooks
already do, so the mechanism, the migration path and the uninstall path all
exist. The alternative, a `.mcp.json` per project, would place a PRCLI file
inside the user's repositories.

### Pane ownership

One browser pane per Claude session, created by the first tool call that needs a
page. Two Claude panes in one project get one browser pane each.

Named as an assumption rather than left implicit: this means two agents cannot
collaborate on one page, and a project running several sessions can accumulate
several agent browsers in the column. Both are accepted.

The pane carries an **agent flag** while its owning session is alive. It decides
two things: the strip is drawn, and navigation is confined. When the session
ends the flag clears and the pane becomes an ordinary browser pane, which is
what makes "the pane survives" and "the agent is confined" compatible rather
than contradictory.

### Driving the page

Main resolves the pane's `webContents` through `getWebContentsId()` and attaches
`debugger`. No remote debugging port is opened: a port would expose PRCLI's own
UI to anything that connects, and would make target selection manual.

## The tool surface

Modelled on Claude in Chrome's tools, with one simplification that only an
in-terminal browser can make: **every tool loses its target parameter.** Chrome's
equivalents all require a `tabId` and a `tabs_context_mcp` call to discover it.
Here the calling session owns exactly one browser pane, so there is no tab
discovery step and no wrong-tab class of error.

| Tool | Parameters | Notes |
| --- | --- | --- |
| `browser_navigate` | `url`, or `"back"` / `"forward"` | Subject to confinement, below |
| `browser_read_page` | `filter` (`interactive` or `all`), `depth`, `ref_id`, `max_chars` | Accessibility tree with `ref_N` ids |
| `browser_find` | `query` | Natural language, up to 20 refs |
| `browser_computer` | `action`, plus `ref` or `coordinate`, `text`, `scroll_direction`, `scroll_amount`, `region`, `modifiers`, `repeat`, `duration` | Actions: `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`, `scroll`, `scroll_to`, `hover`, `screenshot`, `zoom`, `wait`, `left_click_drag` |
| `browser_form_input` | `ref`, `value` (string, number or boolean) | Sets a field directly, so a checkbox needs no click that might land on its label |
| `browser_console` | `pattern`, `onlyErrors`, `limit`, `clear` | |
| `browser_network` | `urlPattern`, `limit`, `clear` | |

Three conventions are copied deliberately, because each encodes a lesson:

- **Refs are the currency.** `browser_read_page` and `browser_find` mint them;
  `browser_computer` and `browser_form_input` consume them. A ref survives a
  re-render where a coordinate does not, and coordinates remain available for
  the icon with no accessible name.
- **The noisy tools demand a filter and offer `clear`.** Without `clear`, a
  second read returns everything again and the model cannot tell new output from
  old. `browser_read_page` truncates at a line boundary and reports the full
  size, so a truncated read is never mistaken for a complete one.
- **Screenshot is an action, not a mode.** It costs image tokens, so it happens
  when the model judges the question visual, with `zoom` for a region rather
  than a full recapture.

**No `evaluate` or `javascript` tool.** Chrome has one. Including it would make
every confinement rule below unenforceable, since arbitrary script in the page
can fetch anywhere the page can. Adding it later must be its own decision, taken
with that consequence in view, rather than a quiet part of this one.

## Confinement

**What is allowed:** `localhost`, `127.0.0.1`, `::1`, any `*.localhost`, on any
port. Loopback only. One predicate, in `src/shared/`, so main and the renderer
cannot spell it differently, which is the rule `canHaveSession` and `regionOf`
already follow and for the same reason.

Checked while writing this: **there is no per-project host setting today.**
`ProjectRecord` carries id, name, slug, cwd, presets and the two selections, and
nothing else. An allowlist entry per project would need a new stored field, its
normalisation, its restore path and its UI, which is a feature in its own right
rather than a clause in this one. So it is out of scope here, and the predicate
takes no configuration: a project served on a non-loopback host cannot be driven
by these tools until that field exists.

**Where it is enforced, which is the part the design turns on.** Checking the URL
inside `browser_navigate` is not enough: the agent can click a link and the page
navigates itself. Enforcement therefore sits on the pane's `webContents`, on
`will-navigate` and `will-redirect`, and applies while the agent flag is set.

A blocked navigation is never silent. The tool call returns an error naming the
origin it refused, and the strip shows it. A model that cannot see its own
denial retries forever.

## The strip

Drawn above the page in agent-owned panes only, showing the last call
(`click ref_12 "Save"`, `navigate localhost:5173/settings`,
`blocked: github.com`) and a marker that the pane is agent-driven. It disappears
when the flag clears.

## Failure states

- **A tool call arriving mid-navigation** must wait for load rather than act on
  the outgoing page.
- **A crashed guest**: the pane already shows a recoverable card; the tool must
  report the crash rather than time out.
- **A hung page.** M1 cut its hung-page banner because `<webview>` emits no
  `unresponsive` event, and deferred it to M2 on the grounds that M2 would build
  main-side access anyway. That prediction holds: a CDP attach can tell, so the
  banner becomes available here.
- **DevTools taking the debugger.** Opening DevTools on the same target detaches
  it. The rule: DevTools wins, and the tools report themselves unavailable while
  it is open, rather than failing obscurely.

## Testing

- The origin predicate and every tool's argument handling are plain unit tests.
- The bridge is testable against a raw socket with no app around it, exactly as
  `hooks/server.ts` is.
- Driving the page needs main-side assertions through `executeJavaScript`:
  measured on this codebase, Playwright cannot enter a `<webview>`, `frames()`
  reports `about:blank` and `frameLocator` throws.
- **The acceptance check that matters is a sabotage one:** point a tool at a
  non-local origin, through both routes (a direct `browser_navigate` and a click
  on a link), and confirm each is refused. A confinement nobody tried to breach
  is a claim rather than a control.

## Out of scope

- An `evaluate`/`javascript` tool, for the reason given above.
- Two agents sharing one browser pane.
- Driving the user's own browser panes.
- Any tool surface for the terminal panes: this document is about the browser.
