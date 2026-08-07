# Settings pane: line tabs, one file per section

Date: 2026-08-07
Status: approved, not yet planned

`SettingsPane.tsx` is 489 lines holding four stacked sections in one scrolling dialog.
Split it into four line tabs, one file each, with the app version moved to a footer.

## What is wrong today

- Four sections stack vertically inside a single `DialogContent`. The dialog only gained
  `max-h-[85vh] overflow-y-auto` after the Updates row's `Check now` button went off the
  viewport with no scroll container to bring it back (measured 2026-08-06, recorded in the
  comment on that element).
- The dividers do not agree with the reading order. Sections appear as Hooks, Shell history,
  Notifications, Updates. Hooks and Shell history carry `mb-4 border-b border-border pb-3`,
  Notifications carries nothing, and Updates carries the divider classes while being last,
  so it draws a rule under the end of the dialog.
- One component owns four independent IPC reads, three separate error states, three busy
  flags and two `[open]` effects. Every section's state is in scope of every other section's
  JSX.

## Decisions

| Question | Decision |
|---|---|
| Grouping | Four tabs, one per existing section |
| Tab order | Notifications, Hooks, Shell history, Updates |
| Default tab | Notifications |
| Version string | Moves out of the Updates row into a footer under a divider, visible on every tab |
| File layout | One file per section under `src/renderer/settings/`, plus a shell and a tab strip |
| Tab strip | Hand-rolled, no new dependency |
| Inactive tabs | Unmounted, not hidden |

Notifications is the default because it is the only tab a user changes more than once. Hooks
and Shell history are one-time installs, and Updates is a button you press when you wonder.

## Files

```
src/renderer/settings/
  SettingsPane.tsx          Dialog, tab state, tab strip, footer
  SettingsTabs.tsx          the line-tab strip
  NotificationsSection.tsx  rules table, mute-when-focused checkbox
  HooksSection.tsx          hooks state, collisions, pending block, Install/Uninstall
  ShellHistorySection.tsx   paths, disclosure copy, pending block, Install/Uninstall
  UpdatesSection.tsx        Check now, Download, Skip this version
```

`src/renderer/SettingsPane.tsx` is deleted and the import in `App.tsx:16` is repointed at
`./settings/SettingsPane`. No re-export shim: one import site, so a shim would be a second
name for the same thing with nothing to justify it.

The component moves keep their copy and their comments verbatim. The shell-history
disclosure paragraph in particular is asserted fact by fact by `shellHistorySettings.spec.ts`
and the comment above it records why each sentence is there; both travel with the section.

## Ownership

The shell owns:

- `open` / `onOpenChange`, passed through from `App.tsx` unchanged
- which tab is active
- `appVersion()`, for the footer

Each section owns its own IPC reads, its own error state and its own busy flag. Nothing
that is private to one section is visible to another.

Props into sections are only what `App.tsx` already supplies, which is Notifications alone:

```tsx
<NotificationsSection notifications={notifications} onNotificationsChange={onNotificationsChange} />
<HooksSection />
<ShellHistorySection />
<UpdatesSection />
```

The three unpropped sections fetch on mount. Today those reads run in an effect keyed on
`[open]`, so they refetch each time the dialog opens; with inactive tabs unmounted, mount
happens when you select the tab, which keeps the same property for the same reason (another
pTerm window, or a hand edit, may have changed the file since it was last read) and narrows
it: nothing is read for a tab you never look at.

## The tab strip

`@radix-ui/react-tabs` is not a dependency of this project and is not being added; only
`@radix-ui/react-dialog` is installed. The strip is about 45 lines:

```
Notifications   Hooks   Shell history   Updates
▔▔▔▔▔▔▔▔▔▔▔▔▔
```

- `<div role="tablist">` of `<button role="tab" aria-selected>`.
- Active tab: `text-fg` and a 1px bottom border. Inactive: `text-faint`, no border.
- Left and Right arrow move the selection, written out explicitly with a roving `tabIndex`
  (the active tab is `tabIndex={0}`, the rest `-1`). This is our own code, not a capability
  assumed from a library.
- `data-testid="settings-tab-notifications"`, `-hooks`, `-shell-history`, `-updates`, and
  `data-active` on the selected one.

The strip takes `tabs`, `active` and `onSelect`. It is its own file so the arrow-key handling
has one place to live and one place to be read.

## Layout

```
┌──────────────────────────────────────┐
│ SETTINGS                             │
│                                      │
│ Notifications  Hooks  Shell h.  Upd. │
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔                        │
│                                      │
│  …active section…                    │
│                                      │
│ ──────────────────────────────────── │
│ pTerm 0.2.3                          │
└──────────────────────────────────────┘
```

`max-h-[85vh] overflow-y-auto` stays on `DialogContent`. One tab's body is much shorter than
four sections, so it should rarely engage, but the reason it was added has not stopped being
true for a short window and it costs nothing to keep.

The footer keeps `data-testid="update-current-version"` so `settingsUpdate.spec.ts` finds the
version without selecting a tab, and gains the `pTerm` prefix in its visible text.

## Accepted cost

Leaving the Updates tab discards the result of a check. `updateResult` lives in
`UpdatesSection`, which unmounts. Pressing `Check now` again is one click and a network
round trip. Lifting the result into the shell to survive a tab switch would put one section's
state back in the shell, which is the thing this change is undoing.

## Tests

Three existing e2e specs reach into rows that are now behind a tab. Each needs one click:

| Spec | Change |
|---|---|
| `tests/e2e/status.spec.ts` (~line 681) | click `settings-tab-hooks` after opening the pane |
| `tests/e2e/shellHistorySettings.spec.ts` | click `settings-tab-shell-history` after opening |
| `tests/e2e/settingsUpdate.spec.ts` | version assertion unchanged (footer); click `settings-tab-updates` before `update-check-now` |

New `tests/e2e/settingsTabs.spec.ts`:

- opening the pane shows the Notifications section and `settings-tab-notifications` is the
  active tab
- clicking each of the other three shows that section and gives the previously active
  section a count of 0, which is what distinguishes unmounting from hiding
- the version footer is present on every tab
- Right arrow from the first tab selects the second

Existing unit tests: `globalRule` and `updateResultText` are pure modules imported by the
sections and are untouched.

## Not doing

- No new settings, no new IPC, no changed copy. Every string that ships today ships after.
- No "open Settings on tab X" command. Nothing asks for it.
- No persistence of the last-used tab. It opens on Notifications every time.
