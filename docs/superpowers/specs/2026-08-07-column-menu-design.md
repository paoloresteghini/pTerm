# Column visibility in the View menu

Date: 2026-08-07
Status: approved, not yet planned

Six checkbox items in the View menu, one per side column, ticked when that column is open.
Plus one item that hides every column and restores the set you had.

## Decisions

| Question | Decision |
|---|---|
| Which "panes" | The six side columns: Files, Skills, Presets, Prompts, Notes, Git |
| Menu items | Checkbox items showing real state, flat in View, not a submenu |
| Accelerators | `⌥⌘F` `⌥⌘S` `⌥⌘P` `⌥⌘R` `⌥⌘N` `⌥⌘G`, all verified unclaimed |
| Who handles the keystroke | The renderer, via `registerAccelerator: false` |
| The existing `⇧⌘\` | Repurposed from "Toggle Presets" to hide/show all columns |
| Notes' collapse state | Lifted out of `NotesPanel` into `App.tsx`, like the other five |

## The menu

```
View
  ✓ Files              ⌥⌘F
    Skills             ⌥⌘S
  ✓ Presets            ⌥⌘P
    Prompts            ⌥⌘R
    Notes              ⌥⌘N
  ✓ Git                ⌥⌘G
  ─────────────────────
    Hide All Columns   ⇧⌘\
  ─────────────────────
    Reload
    Toggle Developer Tools
    …
```

Order matches the columns on screen, left to right, so the menu reads like the window.

## Why the renderer handles the keystrokes

Every item sets `registerAccelerator: false`, which makes Electron *display* the accelerator
without *capturing* it. The keystroke is then implemented in `App.tsx`'s window keydown
handler alongside every other binding.

That is not a stylistic choice. `App.tsx`'s handler returns early inside any element carrying
`data-shortcuts="off"`, which every text input in the app sets. An Electron-registered
accelerator would bypass that and fire while the user was typing, which is exactly the defect
`App.tsx`'s own comment records having shipped once before ("⌘W during a project rename closed
a tab and destroyed its session"), and which the git column's commit box hit again on
2026-08-06. Six new global accelerators is six new ways to hit it.

The existing `toggle-presets` item already uses `registerAccelerator: false`, so this follows
the file rather than introducing a rule.

### Combinations verified free, 2026-08-07

Read off `App.tsx`'s keydown handler: `⌘T`, `⌘W`, `⌘S`, `⌘D`, `⌘K`, `⌘,`, `⌘1`-`⌘9`,
`⌥⌘1`-`⌥⌘9`, `⌥⌘` with an arrow, and `⇧⌘\` are taken. `⌥⌘` with a letter is not. Note the
handler tests `event.code` and excludes `altKey` explicitly on the single-letter bindings, so
`⌥⌘S` is not `⌘S`.

The menu roles in View also hold `⌘R` (`reload`) and `⇧⌘R` (`forceReload`). `⌥⌘R` for Prompts
is distinct from both and does not collide, but it sits one modifier away from reload, which
is worth knowing before choosing it. It is taken deliberately: the letters are mnemonic
(`F`iles, `S`kills, `P`resets, p`R`ompts, `N`otes, `G`it), `P` is spent on Presets, and a
non-mnemonic key for one column out of six would be harder to remember than a near miss.

## Getting state into the menu

The collapse flags live in the renderer; the menu lives in main. They are joined by one
fire-and-forget channel.

`pterm:columnsVisible` carries `{ files, skills, presets, prompts, notes, git }`, sent by
`App.tsx` on mount and whenever any flag changes. It uses `send`, not `invoke`, following
`setActive` and `setLayout`: nothing is returned and nothing waits.

Main does **not** rebuild the menu on each message. It looks each item up by `id` and assigns
`checked`, which keeps the menu definition static and the update cheap. The existing item
already carries an `id`, so the lookup pattern is established.

Main sets the last item's **label** from the same message: "Hide All Columns" when any column
is open, "Show All Columns" when none are. The item then never claims to do the opposite of
what it will do.

The renderer stays the source of truth. Main holds a copy for display only, and a lost or
out-of-order message costs a stale tick, not a wrong toggle: every command still asks the
renderer to flip its own state, and the next message corrects the display.

## Lifting Notes

`NotesPanel` currently owns its collapse state and its `pterm:notesCollapsed` key internally
and takes no props for either, so `App.tsx` can neither read nor change it. It moves to the
same shape as the other five columns: `collapsed` and `onToggle` props, state and key owned by
`App.tsx`.

This is required, not opportunistic. Notes cannot show a checkmark, respond to `⌥⌘N`, or take
part in hide-all while its state is private. It also removes the miscount that has already
bitten twice: both a comment in `splits.spec.ts` and the git panel's own plan said "four
collapsible columns" when there were five, because Notes was invisible to whoever counted.

The stored key keeps its name and its meaning (`'0'` is expanded, anything else collapsed), so
an existing profile opens with the panel it had.

## Hide all, and restoring

One item, two behaviours, decided by whether anything is open:

- **Any column open:** remember exactly which are open, then close all six.
- **No column open:** reopen exactly the remembered set.
- **No column open and nothing remembered:** do nothing.

The third case is a deliberate no-op rather than a guess. A fresh profile starts with every
column collapsed, and inventing a default there would open columns the user never asked for,
which is the rule the columns already follow ("a new column must not take terminal width
unasked").

The remembered set is per-window session state, held in `App.tsx`. It is not persisted: it
answers "what did I have open a moment ago", and a set restored from last week is not that.

The logic lives in `src/renderer/lib/columnVisibility.ts` as pure functions over a plain
record, following `mutationGuard.ts` and `diffLines.ts`. Keeping it out of the component is
what makes the round trip unit-testable, since this repo's vitest runs `environment: 'node'`
with no DOM.

## Commands

`MenuCommand` gains `toggleFiles`, `toggleSkills`, `togglePrompts`, `toggleNotes`,
`toggleGit` and `hideAllColumns`. `togglePresets` already exists and stays, but now means only
Presets: its current behaviour of moving Skills and Presets together is a leftover from when
they shared one column, and nothing else depends on it.

## Testing

**Unit,** `tests/unit/columnVisibility.test.ts`: hide-all remembers the open set and closes
everything; restore reopens exactly that set and nothing else; the round trip is identity; a
restore with nothing remembered is a no-op; hide-all with one column open remembers one.

**End to end,** `tests/e2e/menuColumns.spec.ts`, reading the real menu rather than the
renderer's idea of it:

- a column's item is ticked when the column is open and unticked when it is not
- triggering the item from the menu opens or closes that column
- opening a column by clicking its strip updates the item's tick, which is the sync direction
  a renderer-only test cannot see
- "Hide All Columns" closes every open column, and triggering it again restores exactly them
- the item's label reads "Show All Columns" once everything is hidden

Menu state is reachable from Playwright through the main process, e.g.
`app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-git')?.checked)`,
and items can be triggered the same way. That is what makes the checkmark half testable at all.

**No pixel cost.** This adds no on-screen chrome, so `splits.spec.ts`'s width arithmetic is
untouched, unlike the last two columns added.

## Out of scope

- reordering columns
- per-project remembered layouts
- duplicating any of this in the Window menu
- persisting the hide-all memory across relaunches
- a shortcut for the terminal pane grid, which the Pane menu already covers
