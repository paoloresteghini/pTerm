# Renaming tabs

A tab reads `hartfordrents · b047af`: its project's slug, then the first six
characters of its pane id. That is enough to tell two tabs apart and nothing
more. Someone running four sessions in one project has four rows that differ
only by a hex fragment they never chose and cannot remember.

This lets a tab be given a name, and shows that name everywhere the tab is
listed.

## What a tab is here, which the names in the code disagree about

`TabDescriptor` is a **pane**. `TabRow` is a **tab**. The tab bar and the
sidebar both list `state.panes`, filtered by project (`tabsOfProject`), so both
draw one row per pane rather than one per tab.

That matters twice over. It is why a name stored on the pane appears in both
surfaces with nothing to keep in sync: they are already reading the same array.
And it means a split tab, which is one `TabRow` holding two panes, contributes
two rows to the tab bar today. That is pre-existing and this design does not
change it, but it does decide what a rename attaches to: the thing the user
clicked, which is a pane.

Neither surface needs the slug. The tab bar shows only the active project's
tabs, and the sidebar nests its rows under their project. The slug is in the
current label because there was nothing else to put there.

## Where the name lives

One new optional field on `TabDescriptor` in `src/shared/ipc.ts`:

```ts
/** What the user called this tab. Absent means it has never been named. */
title?: string
```

And one pure selector beside the other derivations in `src/renderer/workspace.ts`:

```ts
export function labelOfPane(pane: TabDescriptor): string
```

It returns `pane.title` when there is one and `` `${pane.projectSlug} · ${pane.id.slice(0, 6)}` ``
otherwise. Both `TabBar.tsx` and `Sidebar.tsx` call it instead of building the
string themselves, which is the whole of "it should reflect on the sidebar
too": there is one label rule and two callers, rather than two copies that can
drift. `DeadPane.tsx` and `TabBar.tsx` each carry a third and fourth copy of
that same template today, for `aria-label`s; those move to the selector too.

The selector lives in `workspace.ts` rather than in a component because vitest
here runs in the `node` environment with no jsdom (`vitest.config.mts`), so a
rule inside a component cannot be unit tested and a rule here can.

**Absent versus empty.** `title` is absent when never set, and setting it to an
empty string is how a name is removed. The selector treats both the same, so
`title: ''` never reaches the screen; the distinction only exists between the
renderer and the store, and `renameTab` normalises it away (below).

## Editing it

Two entry points, one code path.

**Double-click the label** swaps it for an `<input>` seeded with the current
name, selected. This is the terminal-app idiom and costs no chrome.

**Right-click the tab** opens a context menu whose only item is `Rename…`. A
context menu rather than a visible `⋯` button like the sidebar's: the bar is
`h-8` and already carries a status dot, a label, a close button and, for a dead
tab, two more. There is no room for a sixth control, and a menu that appears
only when asked for costs none.

Both set the same editing state, so there is one input, one commit path and one
set of rules. Those rules are the three `Sidebar.tsx` already uses for renaming
a project: **Enter commits, Escape cancels, blur commits.** Its `finishRename`
guards against committing twice through a `useRef`, because Enter and Escape
both unmount the input and Chromium does not reliably follow that with a blur.
The same guard is needed here for the same reason.

The input carries `data-shortcuts="off"`. `App.tsx`'s ⌘ handler checks for that
attribute and returns early, and the comment there records why: without it, ⌘W
typed during a rename closed the tab and destroyed its session, throwing away
the half-typed name. A rename field that did not opt out would reintroduce
exactly that, on a tab this time.

**An empty name clears it**, reverting the tab to `slug · id`. This differs
deliberately from renaming a project, where a blank is ignored: a project with
no name would be unusable, whereas a tab has a perfectly good default to fall
back to, and blank-to-clear is the only way to undo a rename without retyping a
hex fragment by hand. `renameTab` stores a trimmed name and treats the empty
string as a request to remove the field.

## Persisting it

`title` joins the saved pane record in `src/main/state/store.ts`, and the config
version goes **5 to 6**.

The bump is not ceremony. `PrcliStore` already refuses to overwrite a file whose
version is newer than the build's, so without a bump an older build would read a
v5 file, not know about `title`, and drop every name on its next write, silently.
A version number is what makes that refusal fire instead.

Migration is the easy direction: a v5 row has no `title`, which is exactly what
"never named" already means, so v5 folds into v6 with the field left absent. The
existing `[1, 2, 3, 4]` branch keeps working unchanged and now produces v6.

One new IPC call:

```ts
renameTab(id: string, title: string): Promise<TabDescriptor[]>
```

It resolves to the whole pane list for the same reason every project mutation
resolves to the whole project list: the renderer replaces state wholesale from
one authoritative reply, so a mutation and a relaunch cannot disagree about what
is on screen.

**Nothing about tmux changes.** A tab's tmux session name is
`prcli-${slug}-${id}` and restore matches saved rows against live sessions by
it. The title is display text held beside that, never part of it. Filing a tab
into another project does rename its tmux sessions (`moveTabToProject`), and
that is a different operation with a different reason.

## Testing

**Unit, `tests/unit/workspace.test.ts`:** `labelOfPane` with a title, without
one, and with `title: ''`, which must fall back rather than render an empty tab.

**Unit, `tests/unit/store.test.ts`:** a v5 config migrates to v6 with panes
intact and no title; a v6 config with titles round-trips them; a v6 config whose
`title` is not a string drops the field rather than trusting it, matching how
`normaliseProject` already treats untrusted rows.

**E2E, one test in `tests/e2e/tabs.spec.ts`:** open a tab, rename it by
double-click, assert the new name in the tab bar and in the sidebar row, then
relaunch and assert it survived, then blank it and assert both surfaces show
`slug · id` again. The relaunch is the half no unit test can reach, and the
sidebar assertion is the half the user actually asked for.

The right-click path gets its own smaller e2e assertion in the same test:
opening the context menu and clicking `Rename…` reaches the same input. Two
entry points into one path means the second needs only to prove it arrives.

## Files

| file | change |
|---|---|
| `src/shared/ipc.ts` | `title?: string` on `TabDescriptor`; `renameTab` on `PrcliApi` |
| `src/renderer/workspace.ts` | new `labelOfPane` |
| `src/renderer/TabBar.tsx` | inline rename input, context menu, calls `labelOfPane` |
| `src/renderer/Sidebar.tsx` | calls `labelOfPane` for its tab rows |
| `src/renderer/DeadPane.tsx` | calls `labelOfPane` for its `aria-label` |
| `src/renderer/App.tsx` | `renameTab` handler, passes it to `TabBar` |
| `src/main/state/store.ts` | `title` on the saved pane row; v5 to v6 |
| `src/main/ipc/register.ts` | `renameTab` handler |
| `src/preload/index.ts` | `renameTab` bridge |
| `tests/unit/workspace.test.ts` | `labelOfPane` cases |
| `tests/unit/store.test.ts` | v5 to v6 migration and title round-trip |
| `tests/e2e/tabs.spec.ts` | rename, reflect, relaunch, clear |
