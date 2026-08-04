# NOTES panel

Date: 2026-08-04
Status: approved (design conversation, this session)

## What

A collapsible NOTES column at the right edge of the window, to the right of the
existing Skills/Presets column. One freeform plain-text area per project:
startup commands, call notes, whatever. Auto-saves. Text is per-project;
collapsed/expanded state is global.

## Layout

- New component `src/renderer/NotesPanel.tsx`, rendered in `App.tsx`'s main flex
  row immediately after the `{panelOpen ? <RightPanel/> : null}` slot
  (`App.tsx:977`) and before `CommandPalette` (an overlay, not a flex sibling).
- Renders regardless of `panelOpen`: the Skills/Presets column and the notes
  column open and close independently.
- Expanded: fixed width `w-64`, `shrink-0`, `border-l border-border bg-surface`,
  same type scale as `RightPanel` (`font-mono text-[11px]`). Header row "NOTES"
  in the same `text-[10px] uppercase tracking-wider text-faint` style, then one
  `<textarea>` filling the remaining height (`flex-1`, `resize-none`,
  `scroll-thin`, transparent background, no focus ring beyond the app's usual).
- Collapsed: thin full-height strip (~24px) with a vertically written "NOTES"
  label. Clicking the strip expands; clicking the header collapses. One button
  semantic in both states.
- Test ids: `notes-panel`, `notes-toggle`, `notes-textarea`, `notes-empty`.
  Prefix `notes-` collides with no counted prefix in the e2e suite (`tab-` and
  `skill-` are the counted ones).

## Storage

- One file per project: `<configRoot()>/notes/<projectId>.md` (default
  `~/.prcli/notes/<id>.md`). `PRCLI_CONFIG_DIR` moves it like everything else
  that lives beside config.json, so tests never touch the real directory.
- Read of a missing or unreadable file resolves to `''`. Never throws.
- Write: `mkdir` recursive, write to `<file>.<pid>.tmp`, `rename` over target,
  `rm` the temp on failure. Same atomic pattern as `ConfigStore.write`.
- Deleting a project leaves its note file behind. Orphans are small and
  harmless; no cleanup pass.

## IPC

Two new channels, wired the same way as `skills`:

- `shared/ipc.ts`: `CHANNELS.notesRead = 'prcli:notesRead'`,
  `CHANNELS.notesWrite = 'prcli:notesWrite'`; API surface
  `notesRead(projectId: string): Promise<string>` and
  `notesWrite(projectId: string, text: string): Promise<void>`.
- `src/main/notes/store.ts`: `readNote(id)`, `writeNote(id, text)`. Read never
  rejects; write may reject (renderer ignores it, below).
- `src/main/ipc/register.ts`: two `ipcMain.handle` lines.
- `src/preload/index.ts`: two forwarding entries.
- Project id is used verbatim as a filename segment. Ids are app-allocated
  (never user text), so no sanitisation layer; the note module still refuses
  ids containing `/` or `..` as cheap insurance, returning `''` / no-op.

## Renderer flow

- `NotesPanel` receives `project` (same prop shape as `RightPanel`).
- On mount and on `project?.id` change: reset local text to `null` (loading),
  call `notesRead`, set text if not cancelled. Cancelled-flag cleanup exactly
  like the skills fetch in `RightPanel.tsx:22-43`.
- Typing updates local state immediately and marks a pending save:
  `{ projectId, text }` in a ref, captured at edit time.
- Debounced write, 500ms after last keystroke. Flush the pending ref
  immediately on: textarea blur, project switch (effect cleanup), component
  unmount. Because the ref carries the project id from edit time, a switch
  mid-debounce writes A's text under A's id, never B's.
- Write failures are swallowed. Same policy as the skills fetch: this panel is
  not where transport faults get reported, and the local text is still on
  screen.
- The textarea carries `data-shortcuts="off"` so the `App.tsx:577` guard
  exempts it: without that, ⌘W typed mid-note closes a pane and its tmux
  session.
- No project selected: header still shows, textarea replaced by
  `notes-empty` placeholder "No project selected." (matches RightPanel copy).

## Collapse state

- `localStorage` key `prcli:notesCollapsed`, values `'1'` / absent. Read once
  at mount into `useState`, written on toggle. Global across projects,
  restored on relaunch. No config.json change, no version bump.

## Testing

- Unit (`src/main/notes/store.test.ts` or the repo's prevailing location):
  read missing file → `''`; write then read roundtrip; write creates the
  `notes/` directory; id containing `/` or `..` → read `''`, write no-op.
- E2E: new spec file `tests/e2e/notes.spec.ts` with its own page (a fresh spec
  file, so no earlier test's typing makes an assertion vacuous). Flow: select
  project, type into `notes-textarea`, switch project (textarea now shows that
  project's note: empty for a fresh project), switch back, text restored. Collapse: click toggle,
  textarea gone, click again, back. Relaunch persistence of the collapse bit
  is not e2e-asserted (localStorage, manual check).
- Autosave timing in e2e: assert persistence via the project-switch roundtrip
  (switch forces a flush), not by racing the 500ms debounce.

## Out of scope

Markdown rendering, resizable width, search across notes, note history,
per-project collapse state, cleanup of orphaned note files.
