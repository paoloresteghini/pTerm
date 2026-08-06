# Acknowledging a Needs You row

## The problem

`NEEDS YOU` lists every tab whose session is `waiting` or `crashed`. Clicking a row jumps
to that tab and nothing else: the row stays, the dock badge stays, the amber dot stays.
Today the only way to clear a `waiting` is to type something into that Claude session, even
"ok". A row you have read, decided about, and chosen to leave alone has no way to say so,
so the list stops being the answer to "what is blocking me" and becomes a list to
re-triage.

## What this adds

A tick at the end of each Needs You row that marks the tab actioned. One click, no
confirmation, no undo beyond the session speaking again.

Clicking the row itself still only jumps. That separation is the point of the request:
visiting a tab is not the same as having dealt with it, and at twelve concurrent sessions
the difference is the whole value of the list.

## Behaviour

| From | Tick leaves it | Why |
| --- | --- | --- |
| `waiting` | `idle` | Alive, not blocking you. Grey, still present. |
| `crashed` | `ended` | The session is dead. `idle` would be a lie about a dead session. |
| anything else | unchanged | An ack that raced a state change must not invent a state. |

In the two acknowledged cases the row leaves Needs You and the dock badge drops, because
both are derived from the same states: `needsYou()` in `workspace.ts` filters on
`waiting`/`crashed`, and `waitingCount()` counts `waiting`. The no-op case changes
nothing and is not visible anywhere.

Acknowledging never toasts and never plays a sound. A toast fired by the act of dismissing
a toast's subject is noise by construction, and `idle` has toasts on by default, so an
unguarded ack would fire one every time.

The registry's existing `silent` option cannot deliver that. `silent` suppresses the
listeners themselves, which is right for a spool replay but wrong here: the renderer's
`statusChanged` broadcast and the dock badge are both listeners, so a silent ack would
change main's state and leave the sidebar showing amber. What is needed is the opposite
split: emit the transition, and tell the notifier alone to skip it.

So `StatusTransition` gains an optional `quiet` flag, `acknowledge` sets it, and
`NotificationRouter.notify` returns early on it. The badge still refreshes, because
`handle`'s `finally` refreshes it for every transition including the `to: null` forgets it
already ignores. `silent` (emit nothing) and `quiet` (emit, do not announce) are one letter
apart in meaning and easy to confuse, so each one's comment must say what the other is
for.

Nothing is persisted. The registry is in memory, and `drainSpool` rotates the spool at
launch, so a relaunch cannot replay the acknowledged event and resurrect the row.

An acknowledgement sticks until the session actually moves, rather than clearing on the
next `waiting`. Claude re-fires `Notification` roughly once a minute while a prompt sits
unanswered (measured), and the registry's only defence against that repeat is its
`from === to` dedupe in `set`. Acknowledging writes `idle`, which disarms that dedupe: the
very next re-fire, about a minute later, is then a real `idle -> waiting` transition, not a
repeat, and would bring the row back with a toast, a sound and the badge, for a prompt the
user already read and deliberately left alone. So the registry keeps a memo of acknowledged
tab ids; while a tab's id is in it, a transition *to* `waiting` is dropped outright rather
than merely deduped, and the tab stays `idle`. Any other transition for that tab — thinking,
idling, dying, restarting, forgetting — clears the memo, because all of those are real
activity: a genuine new question that follows real activity comes back into the list
normally.

## Design

### 1. `StatusRegistry.acknowledge(tabId)`

```
acknowledge(tabId: string): void
```

Reads the current state, maps it by the table above, and goes through the existing `set`
so the single transition path stays single: one `StatusTransition` out, and every listener
(the renderer's dot, the dock badge, the notification router) hears it the way it hears
every other change. A tab in any other state, or unknown to the registry, emits nothing:
the same rule `forget` already follows for a tab it never knew.

`crashed` carries an entry in `explained`, which is what stops a late `applyExit` from
overwriting a death with an `ended` of its own. Acknowledging a crash must leave that entry
alone: the pane is still dead, the late exit is still meaningless, and the tab has already
been moved to `ended` deliberately. The implementation plan should assert this rather than
assume it.

### 2. IPC

`CHANNELS.acknowledgeTab`, registered with `ipcMain.on` and exposed on the preload bridge,
in the shape `dismissTab` already uses: fire and forget, no reply. The renderer does not
patch its own state optimistically. It calls, and takes the new state from the
`statusChanged` broadcast that follows, so what the sidebar shows is always what main
believes.

### 3. The tick

`NeedsYou.tsx`'s row is a single `<button>` today. It becomes a flex row holding two
buttons: the existing jump button, and a trailing tick.

A button nested inside a button is invalid HTML, and it would also give Playwright two
elements for one row and fail every strict-mode locator that names it. The row therefore
stops being a button and becomes a container.

The tick carries `data-testid={`ack-${tab.id}`}` and `aria-label="Mark actioned"`. It is
visible without hover: a control you have to discover by hovering is a control that does
not exist for the first hour of using the app.

## Testing

Unit, against the registry:

- `waiting` acknowledged becomes `idle`, and emits one transition saying so.
- `crashed` acknowledged becomes `ended`, and `explained` still holds the tab afterwards.
- `thinking` acknowledged is unchanged and emits nothing.
- A tab the registry never knew emits nothing.
- The emitted transition carries `quiet`, and a router handed it shows no toast and plays
  no sound while still refreshing the badge. This is the assertion that fails if someone
  later "simplifies" `quiet` into `silent`.

E2E, in `status.spec.ts`, which already owns the Needs You and dock-badge assertions:

- Inject a `Notification` hook for a tab, assert the row is listed and the badge counts it.
- Click the tick. Assert the row is gone, the tab's dot is the `idle` colour rather than
  absent, and the badge is back to where it was.
- Assert clicking the row itself still only jumps: the tab is selected and the row is
  still listed.

That last one is the assertion that would catch the most likely regression, which is a
click handler on the container swallowing or duplicating the tick's own click.

## Out of scope

- Acknowledging from anywhere but this list (no tab context-menu item, no keyboard
  shortcut). If the tick gets used, those are cheap to add later against the same IPC.
- Undo. The session speaking again is the only thing that brings a row back.
- Persisting acknowledgements across a relaunch. Nothing survives that today, and the
  spool rotation means nothing needs to.
