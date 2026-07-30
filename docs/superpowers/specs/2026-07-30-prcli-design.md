# PRCLI — Design

**Date:** 2026-07-30
**Status:** Approved, pre-implementation

## Problem

Five customers, two to three Claude Code sessions each, plus dev servers and queue workers. Today that means seven VS Code windows and no way to know which session is blocked on a human. Sessions finish or stall unnoticed; finding the one that needs attention costs a window hunt.

## What we're building

A macOS desktop app that runs every terminal session — Claude and otherwise — in one window, and tells you which ones need you.

All five customers stay live all day. The app is the primary terminal, replacing VS Code's terminals and standalone terminal windows.

## Architecture

Three layers, deliberately separable:

```
┌─ Renderer (React + xterm.js + shadcn/ui) ──────┐
│  sidebar · tab bar · pane tree · skills panel  │
└───────────────▲────────────────────────────────┘
                │ IPC (state events, PTY streams)
┌───────────────┴─ Main process ─────────────────┐
│  SessionManager · TmuxAdapter · HookServer     │
│  ConfigStore · NotificationRouter              │
└───────────────▲────────────────────────────────┘
                │ node-pty                │ unix socket
┌───────────────┴───────────┐   ┌─────────┴────────────┐
│  tmux sessions (detached) │   │ Claude Code hooks    │
└───────────────────────────┘   └──────────────────────┘
```

**Stack:** Electron + xterm.js + node-pty, TypeScript throughout. React + Tailwind + shadcn/ui for chrome.

Electron over Tauri because rendering Claude Code's TUI correctly — 24-bit colour, mouse, alt-screen, resize — is a solved problem on this exact stack (VS Code's terminal). Tauri would push high-throughput PTY output across Rust→webview IPC, which is a known backpressure problem for a TUI that redraws constantly. The ~200MB Electron baseline is a one-off, not per-session; sessions live in tmux outside the app.

Native SwiftUI was rejected: SwiftTerm is far less battle-tested than xterm.js, and all UI chrome would be hand-built.

### Process model

**Every pane is one tmux session**, named `prcli-<project>-<uuid>`. Sessions rather than windows because each pane needs independent dimensions — windows within a shared tmux session resize together, which would make splits fight each other.

Closing a tab **detaches**; the tmux session keeps running. Killing is an explicit action with confirmation.

On launch the app runs `tmux ls`, finds every `prcli-*` session and adopts it. An app crash, quit or update costs nothing; orphans from previous runs reappear rather than leaking. Because tmux owns the processes, any pane is reachable from plain Ghostty or over SSH with `tmux attach -t prcli-…` when the app itself is the problem.

**Splitting a tab** creates a pane tree inside that tab (VS Code / iTerm model). The tab bar entry gains a `⊞n` badge and does not multiply. Panes nest arbitrarily and resize by drag. Each pane is still its own tmux session, so it survives restart exactly like a tab.

### Tab types

One mechanism, three flavours — only the launch command and state source differ:

| Type | Launches | State from |
|---|---|---|
| `claude` | `claude` with `PRCLI_TAB_ID` in env | Claude Code hooks |
| `preset` | project-declared command (`npm run dev`, `php artisan queue:work`) | process exit code |
| `shell` | `$SHELL` | process exit code |

Presets are convenience only. Any tab can run any command.

## State model

Claude tabs derive state from hooks, never from scraping output:

```
idle ──UserPromptSubmit──▶ thinking ──Notification──▶ waiting
  ▲                           │                          │
  └──────────Stop─────────────┴──any non-Notification────┘
                                       event

any state ──PTY exit──▶ crashed (non-zero) | ended (zero)
```

`waiting` is the only state meaning *you are the blocker*. Everything else is informational. Non-Claude tabs use `running` → `ended` | `crashed`.

`PreToolUse` fires *before* a permission prompt, so it cannot be the signal that a prompt was answered. Any event other than `Notification` returns a waiting tab to `thinking`.

A Claude tab whose hooks never fire — session started outside the app, hooks removed — resolves to `unknown` and renders a hollow dot rather than reporting a state it cannot know.

**Aggregation:** a split tab takes the worst state among its panes; a project row takes the worst state among its tabs. Severity order: `crashed` > `waiting` > `thinking` > `running` > `idle` > `unknown`.

### Hook bridge

The main process listens on a Unix socket at `~/.prcli/hook.sock`. A script `~/.prcli/bin/prcli-hook` reads Claude's hook JSON from stdin, stamps it with `$PRCLI_TAB_ID` from the tab's environment, and writes it to the socket. Fire-and-forget, no response awaited.

**The hook must never block or fail Claude.** If the socket is absent or the app is not running, `prcli-hook` exits 0 silently.

Install merges into `~/.claude/settings.json`: additive, idempotent, timestamped backup written first. Existing hooks are preserved untouched — `prcli-hook` is appended alongside them. Uninstall removes only PRCLI's own entries.

Subscribed events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.

## Notifications

Every state transition emits an event. Rules decide what surfaces:

```jsonc
{
  "rules": [
    { "on": "waiting",  "toast": true,  "sound": "Funk",  "urgency": "high" },
    { "on": "idle",     "toast": true,  "sound": "Glass", "urgency": "low"  },
    { "on": "crashed",  "toast": true,  "sound": "Basso", "urgency": "high" },
    { "project": "lumio", "on": "idle", "toast": false }
  ],
  "muteWhenFocused": true,
  "quietHours": null
}
```

Later rules override earlier; project-scoped beats global. Sound and toast are independent, so "chime, no popup" is expressible.

`muteWhenFocused` suppresses toasts for the pane currently focused — the single largest noise reduction at twelve live sessions.

Editable through a settings pane, not only by hand.

**Toast** appears top-right, names project and tab, and on click focuses the app and selects that exact pane.

**Dock badge** shows the count of panes in `waiting` — visible with the window hidden behind a browser.

## Layout

```
┌────────────────────────────────────────────────────────────┐
│  PRCLI                                              ⌘K     │
├──────────────┬──────────────────────────────┬──────────────┤
│ NEEDS YOU  2 │ claude·api ⊞3 │ claude·ui │+ │ SKILLS       │
│ ● Lumio·api  ├──────────────────────────────┤ /brainstorm  │
│ ● GCO·queue  │                │ queue       │ /plan-phase  │
│              │  claude · api  ├─────────────┤ /execute     │
│ PROJECTS     │                │ shell       │ PRESETS      │
│ ▸ Adecco   2 │                │             │ npm run dev  │
│ ▾ Lumio    4 │                │             │ artisan queue│
│   ● claude·api                │             │              │
│   ● claude·ui│                │             │              │
│ ▸ GCO      2 │                │             │              │
│ ⚙ Settings   │                │             │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

**Sidebar** — global "Needs you" list pinned at top, then a project tree that expands to show that project's tabs. Project row dot reflects the worst state within.

**Tab bar** — current project only. Split tabs carry a `⊞n` badge.

**Right panel** — skills and per-project presets; collapses with ⇧⌘\ for a full-width terminal. Same content behind ⌘K.

**Context menu** (right-click tab or pane) — Split Right ⌘D, Split Down ⇧⌘D, Rename, Duplicate, Detach to tab, Copy tmux attach command, Kill pane ⌘W.

**Keyboard** — ⌘1–9 switch project, ⌘K command palette, ⌘D / ⇧⌘D split, ⌘W kill pane, ⇧⌘\ toggle right panel.

**Visual language** — shadcn/ui dark theme, zinc base, single accent colour. Status dots: grey `idle`, blue `thinking`, amber `waiting`, green `running`, red `crashed`, hollow `unknown`.

## Data

**Project discovery** scans `~/Code` one level deep for directories containing `.git`, `package.json` or `composer.json`. Candidates appear in an "Add project" picker, not automatically in the sidebar — there are 22 candidates and roughly six are wanted. Sidebar order is draggable.

A repository may ship a `.prcli.json` declaring its own presets, so a project's commands travel with it. Read-only; user config wins on conflict.

**`~/.prcli/config.json`** holds projects, presets, notification rules, and full layout state — open tabs, pane trees, split sizes. Written atomically. Relaunch restores the exact workspace and reattaches every tmux session.

**Skills panel** sources `~/.claude/skills`, enabled plugins, `~/.claude/commands`, and the project's `.claude/commands`. Clicking inserts `/name` into the focused Claude pane.

## Failure handling

| Failure | Behaviour |
|---|---|
| tmux not installed | Onboarding gate offering `brew install tmux`; app will not proceed without it |
| Orphaned `prcli-*` sessions | Adopted on launch |
| Config references a dead session | Marked dead in the UI with one-click restart |
| App not running when a hook fires | `prcli-hook` exits 0 silently — never blocks Claude |
| `settings.json` already modified | Timestamped backup, idempotent merge, clean uninstall |
| Renderer crash | tmux untouched; reload reattaches everything |
| RAM at 12+ live panes | xterm.js scrollback capped per pane; tmux retains deeper history |
| Rapid resize | PTY resize debounced |

## Testing

**Unit** — state machine transitions and severity aggregation, notification rule resolution and override precedence, `settings.json` merge and unmerge, tmux session-name mapping, config migration.

**Integration** — against real tmux: create, adopt, detach, kill, orphan reconcile. Synthetic hook payloads delivered over the socket.

**E2E** (Playwright + Electron) — add a project, open a Claude tab, inject fake hook events, assert dot colour, sidebar badge, toast fired, and that click-to-focus lands on the correct pane.

**Manual smoke checklist** for TUI fidelity — colours, mouse, resize, ⇧Tab permission cycling. Automated tests cannot judge whether Claude Code renders correctly.

## Out of scope for v1

Multi-window. SSH or remote sessions. Theming beyond the shadcn dark theme. Git status in the sidebar. Cross-tab scrollback search. MCP server management. Git worktrees.
