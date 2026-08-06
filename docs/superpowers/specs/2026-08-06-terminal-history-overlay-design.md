# Terminal history overlay

Date: 2026-08-06
Status: approved, not yet planned

Pressing Up in a terminal pane opens a searchable list of past commands, in the manner of
Warp. Selecting one types it onto the prompt.

## Why this is not simply "read `~/.zsh_history`"

Two facts were measured on the target machine on 2026-08-06 and rule that out:

- The file is in **plain format**, not extended. It carries no timestamps, so relative times
  ("2 days ago") cannot be derived from it.
- zsh here has neither `INC_APPEND_HISTORY` nor `SHARE_HISTORY`, and `SAVEHIST=1000`. History
  is flushed **when a shell exits**. PRCLI panes live for days, so a command run a minute ago
  in a live pane is not in the file, and the file is capped at 1000 lines.

An overlay that could not show the command you just ran would not be worth building.

## Decisions

| Question | Decision |
|---|---|
| What opens it | **Up**, in panes of type `shell` only |
| Source of history | A zsh `preexec` hook writing a PRCLI-owned file |
| What Enter does | Types the command onto the prompt; **does not run it** |
| Default scope | Current project only, with a key to widen to all |
| Placement | Anchored to the bottom of the pane it was opened from |

## Behaviour

Up in a `shell` pane opens an overlay rising from that pane's bottom edge. It lists commands
run in the current project, newest first, each with a relative timestamp.

- `↑`/`↓` move the selection
- typing filters by case-insensitive substring
- `Tab` widens the scope to every project, and back
- `Enter` closes the overlay and types the selected command onto the prompt, unexecuted
- `Esc` dismisses, changing nothing

Up is passed through to the pty untouched when any of these hold:

- the pane is not of type `shell` (`claude`, `preset` and `editor` panes are untouched)
- shell integration is not installed
- the list for the current scope would be empty

The third condition is a rule, not an optimisation. Swallowing Up to display an empty list
would take zsh's own history recall away and give nothing back.

### Known cost of the trigger

PRCLI cannot see what a pty is running. A pane launched as `shell` that is currently in
`vim`, `less` or any full-screen program will get the overlay on Up rather than passing it to
that program. This was raised and accepted when the trigger was chosen. If it proves annoying,
an `Alt+Up` passthrough is a small, additive change; it is deliberately not in this scope.

## Shell integration

Modelled on `src/main/hooks/install.ts`, which already writes `~/.prcli/bin/prcli-hook` and
edits the user's Claude settings with collision reporting. The same shape is used here so
there is one way this app modifies a user's config, not two.

- `~/.prcli/bin/prcli-history.zsh` defines a `preexec` hook.
- One guarded `source` line is added to `~/.zshrc`, between markers so uninstall is exact.
- The hook appends one JSON object per line to `~/.prcli/history.jsonl`:
  `{"ts": <epoch seconds>, "cwd": "$PWD", "tab": "$PRCLI_TAB_ID", "cmd": "<command>"}`

`PRCLI_TAB_ID` is already exported into every pane's environment, so no new plumbing is
needed to record which pane a command came from.

Settings gains a **Shell history** row beside the existing hooks row: it shows the exact text
that will be added, installs, and uninstalls. The row must state that only panes started
**after** installing will record anything, because the alternative is a user concluding the
feature is broken.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/main/shell/install.ts` | write the snippet, edit `~/.zshrc`, report collisions, uninstall | fs |
| `src/main/shell/history.ts` | read the tail of `history.jsonl`, parse, dedupe, scope, filter | fs |
| `CHANNELS.historyList` | `(projectCwd, scope)` → entries, newest first | the above |
| `src/renderer/HistoryOverlay.tsx` | render the list, own its arrow-key handling | the channel |
| `src/renderer/Terminal.tsx` | one `attachCustomKeyEventHandler`, for the opening Up only | — |

The scoping, dedupe and filter logic lives in `history.ts` as a **pure function** over parsed
entries, so it is unit-testable with no pty, no tmux and no DOM.

Reading is bounded: only the last 5000 lines of `history.jsonl` are parsed. Entries are
deduped by command text, keeping the most recent occurrence.

## Data flow

1. Up arrives at xterm's key handler in `Terminal.tsx`.
2. The handler returns `false` for the opening Up only, so xterm does not send `\x1b[A`.
3. The overlay opens and takes focus. xterm loses it, so every subsequent keystroke is
   React's without any further interception. This is why only one key is intercepted.
4. `Enter` calls `window.prcli.input(paneId, cmd)` — an existing channel, already used by the
   Prompts and Skills panels to type text into a pane — and closes the overlay.

## Testing

- **Unit**: the pure scope/dedupe/filter function. The `~/.zshrc` edit's idempotency, its
  collision detection, and that uninstall removes exactly what install added.
- **Integration**: `CHANNELS.historyList` against a temp `history.jsonl`, including a
  malformed line, which must be skipped rather than failing the read.
- **E2E**: Up opens the overlay; `↑`/`↓` move the selection; `Enter` puts the text on the
  prompt, asserted by **capturing the tmux pane**, not by reading the DOM; `Esc` dismisses;
  and a pane without integration installed passes Up through to the pty.

Every new test is A/B'd by sabotage before it is counted: a test that has not been seen to
fail has not been shown to test anything.

## Out of scope

Fuzzy matching, exit-status colouring, editing or deleting entries, bash or fish support,
cross-machine sync, per-pane scoping.

## Related defect, not fixed here

`~/.zsh_history` on the target machine contains PRCLI **test** artifacts (`echo prcli-marker`,
`printf "TABID[%s]"`), so the suite writes into the developer's real shell history. The new
`history.jsonl` will inherit exactly this problem unless the suites point `HOME` at a temp
directory. Worth fixing before this feature ships, and tracked separately.
