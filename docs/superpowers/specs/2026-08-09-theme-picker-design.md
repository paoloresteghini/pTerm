# Dark theme picker

**Date:** 2026-08-09
**Status:** design, approved for planning

## The problem

The app is hard to read as a set of distinct surfaces. Two failures were named:
modals do not appear to float above the page, and the side columns do not
separate from the terminal.

Both are the same defect. `index.css` defines `--color-bg: #09090b` and
`--color-surface: #0c0c0e`, three points of 255 apart — **ΔL\* 0.86**. Two named
levels that render as one. Every boundary in the app is therefore carried by a
single 1px `--color-border` (`#27272a`), used 59 times, and a modal is drawn in
the same fill as the page behind it.

### How separation is measured here

**Not by WCAG contrast ratio.** That formula adds a +0.05 flare term which
compresses every near-black comparison into roughly the same number: pure black
against `#1f1f1f` is only 1.20:1, and all five palettes below land between 1.01
and 1.17. The ratio cannot tell them apart. It is built for text on a ground,
not for two dark planes abutting, and a floor set in those units would force the
app's chrome to start around `#1f1f22` — lighter than any concept considered.

**By CIE L\* lightness distance.** ΔL\* ≈ 1 is a just-noticeable difference
between adjacent patches. The working floor adopted here is **ΔL\* 3.0** for
separation that survives a glance. Today's 0.86 is below even the JND, which is
the measured form of the complaint.

Text keeps the ratio, which is the right instrument for it: `label` on `surface`
is held at 4.5:1, as `labelContrast.test.ts` already does.

Verified figures for the five palettes:

| Theme | canvas→surface | surface→raised | raised→overlay | border on surface | label |
| --- | --- | --- | --- | --- | --- |
| Classic | **0.86** | 0.00 | 0.00 | 12.4 | 7.63:1 |
| Stepped zinc | 3.47 | 3.94 | 3.98 | 12.2 | 8.71:1 |
| Lifted chrome | 7.75 | 4.48 | 4.36 | 12.1 | 10.01:1 |
| Tinted slate | 3.82 | 4.53 | 4.92 | 13.5 | 9.53:1 |
| Line-led | 0.56 | 1.70 | 1.21 | **23.8** | 7.67:1 |

### The rule has two branches, not one

Line-led is deliberately below the fill floor: it separates by edge, not by
plane. A single flat-fill rule would fail it, so the rule is:

- a theme separates **by fill** — every adjacent pair clears ΔL\* 3.0; or
- a theme separates **by edge** — it declares so, and its border clears ΔL\* 20
  against its own surface (Line-led: 23.8) with `--color-inset` set.

Classic declares neither and is asserted flat on purpose, as the recorded
baseline.

A border of ~12 is correct for the fill-separating themes. Holding all five to
the edge floor would mark four good palettes as broken.

## What is being built

A theme picker in Settings offering five dark themes, applied instantly and
persisted. Classic is the default and is today's palette unchanged.

| Theme | Idea |
| --- | --- |
| Classic | Today's palette. Default. |
| Stepped zinc | Same zinc family, four genuinely distinct planes above an unchanged terminal. |
| Lifted chrome | Terminal drops to near-black; the whole shell lifts well clear of it. |
| Tinted slate | Cool-cast neutrals deepening with darkness; separation by hue as well as value. |
| Line-led | Grounds stay black; separation from a stronger border, a 1px top highlight, and a heavy scrim. |

A visual board of all five on the real app shell, with the contrast maths, is
at https://claude.ai/code/artifact/2aeeaf3e-45bd-4fa6-9025-aba54a1c8c44

### Non-goals

No light theme. No "follow system". No custom colour editing. No per-project
theme. The app is a dark-only tool; a light mode is a different project with
different problems.

## Architecture

### Palettes live in TypeScript, not CSS

`src/shared/themes.ts` holds a typed record of five palettes. Each carries its
tokens plus a required `separates: 'fill' | 'edge' | 'baseline'` field, which
selects the rule its tests judge it by. A new theme cannot be added without
stating how it separates.

`index.css` keeps
its `@theme` block purely as the *declaration* of which tokens exist — Tailwind
v4 needs that block to emit `bg-surface`, `text-muted` and the rest — while the
values applied at runtime come from the registry.

Tailwind v4 compiles those utilities to `var(--color-*)` references rather than
inlining the literal, which is what makes a runtime override work at all.
**Verify this before building on it**: if the build inlines values instead, the
whole approach changes and the design needs revisiting.

Two reasons for TS over five `:root[data-theme]` blocks in CSS:

1. xterm renders to a canvas and cannot read CSS variables. `index.css:34-36`
   documents this today and instructs the reader to hand-copy two values into
   `Terminal.tsx`. Five CSS themes would make that five hand-copies. One
   registry makes CSS and xterm read the same object.
2. It is testable in vitest's node environment. Contrast ratios across all five
   themes become plain unit tests with no DOM.

The cost accepted: Classic's values exist twice, once in `@theme` and once in
the registry. A unit test pins them equal.

### Token model

Existing token names and meanings are unchanged. Four are added:

| Token | Means | Classic value |
| --- | --- | --- |
| `--color-raised` | selected rows, inputs, hover fills | `#0c0c0e` (alias of surface) |
| `--color-overlay` | modals, command palette, popovers | `#0c0c0e` (alias of surface) |
| `--color-border-strong` | edges of floating things | `#3f3f46` (alias of faint) |
| `--color-inset` | 1px top highlight on raised surfaces | `transparent` |

Classic defines all four as aliases of what those surfaces already use, so
**introducing the token system changes nothing on screen**. Only the four new
themes spend them. This separates the risky mechanical work (repointing call
sites) from the visual work (the palettes), so each can be verified alone.

Call sites to repoint:

- `ui/Dialog.tsx` — `bg-surface` → `bg-overlay`, `border-border` → `border-border-strong`
- `IssueModal.tsx:89` — the modal's body well, currently `bg-bg` → `bg-raised`
- `FileTreeMenu.tsx:69`, `Sidebar.tsx:195`, `TabBar.tsx:270` — context menus, floating
- `Sidebar.tsx:140,167,297`, `TabBar.tsx:246` — selected rows and inputs, currently `bg-bg`

That last group is the subtle one. `bg-bg` currently does double duty as "the
canvas" and "this row is selected". Those are different intents that share a hex
today. Lifted chrome breaks them apart: a selected row must not become the
terminal's black. Splitting them is required for correctness, not cosmetics.

Two call sites named in an earlier draft of this spec turned out not to need
touching, and one that is not obvious does:

- **`CommandPalette.tsx` and `settings/SettingsPane.tsx` need no edit.** Both
  render through `DialogContent`, so the `Dialog.tsx` change carries them.
- **`IssuesPanel.tsx` is not a repoint site.** It marks selection with `text-fg`
  alone and has no `bg-bg`.
- **`TabBar.tsx:202`, the active tab, deliberately stays `bg-bg`.** An active tab
  is continuous with the terminal beneath it, and that unbroken fill from tab
  into canvas is what makes it read as the front one. Under Lifted chrome it is
  the whole effect.

### Per-theme values that must be recomputed, not copied

`--color-group` (`#5e8322`) is documented in `index.css` as the accent blended
55% over `--color-bg`, computed rather than picked. Each theme recomputes it
against its own canvas by that same method. Carrying `#5e8322` across themes
would leave the tab-group strip off-relation to the ground it sits on.

## Storage and startup

### Config

`PTermConfig` gains `theme: ThemeId`, and `version` goes `8 → 9`. Absent or
unrecognised reads as `'classic'` — the same tolerance every other field in
`store.ts` already applies, so a hand-edited `"theme": "purple"` degrades to the
default rather than leaving the app unpainted.

### Applying before first paint

Settings load asynchronously (`NotificationsSection` takes
`NotificationConfig | null`, null until it arrives). A theme on that path would
paint Classic and then swap, on every launch, on a window full of terminals.

The theme therefore travels the same route `webglLimit` already uses:
`createWindow` passes `--pterm-theme=<id>` via `additionalArguments`, the preload
reads it off `process.argv`, and a module imported at the top of `main.tsx` —
before React mounts — stamps `data-theme` and sets the token properties on
`documentElement`. Synchronous, pre-paint, no IPC round trip.

`process.env` is not an option in the preload: vite compiles that bundle with
`process.env` replaced by an empty object literal, so reads there are statically
undefined and fail silently. `src/main/index.ts:455-468` is the long version.

### Bridge shape

`webglLimit` is currently the only non-function member of `PTermApi`. Rather than
adding a second loose value beside it, both fold into one field:

```ts
env: { webglLimit?: string; theme?: string }
```

One object, one place to look, and the next startup-time value does not widen the
API again. Touches the three existing `webglLimit` readers.

### Writing

`updateTheme(id)` alongside the existing `updateNotifications`, same IPC shape.
Main persists and broadcasts. The renderer applies optimistically so the picker
is instant.

`applyTheme(id)` is one function used by both the pre-paint stamp and the picker.
It sets every token as an inline custom property on `documentElement`, which beats
`@theme`'s `:root` on specificity without needing `!important`.

## Settings UI

A new `appearance` entry in `SETTINGS_TABS`, placed **first**. The pane opens on
its first entry, so Settings opens onto a live theme picker.

This displaces Notifications. `tabs.ts` carries a written rationale for why
Notifications leads and why "the other three" are one-time installs; a fifth tab
makes that text false. The implementer must re-derive that comment from what is
true after the change. Do not find-replace it, and do not transcribe wording from
this spec into it — the comment must state something the implementer has
verified.

**The picker:** five cards, apply on click, no Save button.

Each card shows the theme name and its four-step ladder (canvas → surface →
raised → overlay) as stacked swatches. Clicking applies immediately to the whole
app. No preview thumbnail is needed because the app is the preview — and since
Settings is itself a modal over the shell, one click shows the modal treatment,
the panel treatment and the terminal simultaneously, which is exactly the surface
set that was failing.

Instant apply is reversible by clicking another card, so no confirmation step.

`role="radiogroup"` with arrow-key movement, reusing `nextTabIndex`'s
wrap-at-both-ends behaviour rather than writing a second traversal.

Testids follow `settings-tab-${id}`. This does not collide with the
`[data-testid^="tab-"]` prefix that 27+ e2e locators use to count terminal tabs.

## Terminal and pane colours

**Foreground.** `#d4d4d8` is hardcoded at `Terminal.tsx:352` as a hand-copy of
`--color-term-fg`. It becomes a registry read, per theme. This is the duplication
the registry exists to delete.

**Default background.** Panes with no colour of their own are constructed with
`--color-bg`; under Lifted chrome that is `#060607`. Also a registry read.

**Live update.** The effect at `Terminal.tsx:514-524` already updates `background`
live, and its comment explains why `theme` is a settable option rather than a
rebuild. It extends to `foreground`, and its trigger widens from "pane colour
changed" to "pane colour or theme changed". Every mounted pane repaints; no
terminal is recreated and no tmux session is touched.

### One shared pane-colour ramp across all themes

`PANE_COLORS` is a closed 6-value set that `store.ts` validates config against on
the way in.

**A ramp per theme would destroy user data.** A pane explicitly coloured
`#232326` under Classic would fail validation after a switch to Slate, and
`store.ts` would drop it. Switching theme would silently wipe every pane colour
the user had set.

One shared ramp survives because of something the existing design already got
right: `PANE_COLOR_DEFAULT` stores *absent*, not a hex, so a defaulted pane
already means "whatever the canvas is" and follows the theme for free. Only
explicitly-coloured panes hold a literal, and those literals stay valid in every
theme.

What changes:

- the picker's first swatch renders the live canvas rather than a fixed `#09090b`
- `paneColors.test.ts` recomputes its ratio against every theme's foreground and
  holds the worst case above 7:1

If a theme's foreground cannot clear the ramp, that theme's foreground moves. The
ramp does not.

Accepted cost: five zinc pane swatches sit slightly foreign on Tinted slate's cool
ground. Taken over eating user data.

## Testing

### Unit (vitest, node)

- **Fill floor.** For each theme declaring `separates: 'fill'` (Stepped, Lifted,
  Slate): `surface` vs `canvas`, `raised` vs `surface`, `overlay` vs `raised`
  each clear **ΔL\* 3.0**.
- **Edge floor.** For each theme declaring `separates: 'edge'` (Line-led): its
  border clears **ΔL\* 20** against its own surface, and `--color-inset` is not
  `transparent`. Its fill steps are *not* held to the fill floor.
- **Classic's baseline.** Classic declares neither and asserts the *opposite* —
  its ΔL\* 0.86 is recorded deliberately, so nobody later "fixes" it into a
  fourth stepped theme.
- **Every theme declares one.** `separates` is a required field, so a sixth
  theme cannot be added without stating which rule judges it.
- **Text floors.** `label` ≥ 4.5:1 on `surface`, per theme — WCAG ratio, which is
  the correct instrument for text. This generalises the existing
  `labelContrast.test.ts` from one palette to five. `fg`, `ok` and `danger`
  against every ground they land on.
- **`muted`, and the one exemption.** Held at 4.5:1 on every ground for the four
  new themes; all four clear it. **Classic does not**: `#71717a` on `#0c0c0e` is
  4.04:1, and it ships that way today. `FileTree.tsx:384-389` already measured
  that figure and accepted it, on the stated grounds that *"this background is
  fixed chrome the user cannot recolour"* — a premise this feature falsifies.
  The floor is therefore demanded of every theme the feature adds, Classic keeps
  its value because leaving today's palette untouched is the point of it, and
  its exemption is pinned to the measured number so it cannot drift further.
  That comment in `FileTree.tsx` is now stale.
- **Pane ramp.** Every `PANE_COLORS` entry against every theme's foreground,
  worst case ≥ 7:1.
- **Registry/CSS sync.** Parse the `@theme` block out of `index.css` and assert
  its values equal `THEMES.classic`. This is the only guard on the duplication
  the design accepts.
- **Config.** A `version: 8` config reads back as `theme: 'classic'`. An
  unrecognised id reads as `'classic'` rather than crashing.
- **Completeness.** Every theme defines every token, with values that parse as
  hex. A missing key is a type error; a key present with an empty string is not.

### E2E (Playwright)

- Open Settings, click Stepped zinc, assert the **modal's computed background
  differs from the panel's by ≥ ΔL\* 3.0**. This is the feature's actual claim,
  measured — not "a class name changed".
- Relaunch and assert the theme survived, reading computed values.
- Terminal foreground and background: the intended oracle is `.xterm-viewport`'s
  computed background. **Verify that oracle reflects the theme before relying on
  it.** This repo has already shipped a test asserting against `.xterm-rows`,
  which the WebGL renderer leaves permanently empty. If the viewport does not
  reflect the theme, find a different hook rather than leave an assertion that
  passes against nothing.

### Proving the tests are alive

Every new test must be **observed failing** with the feature reverted — run it,
see red. Not reasoned about, run.

This repo has previously shipped ten tests that could not fail, and a "control"
test that passed bit-for-bit with the thing it controlled for deleted. A test
asserting a colour distance is precisely the shape that passes vacuously when it
reads the wrong value: a `getComputedStyle` miss returns `rgba(0, 0, 0, 0)`, and
a ΔL\* computed against that will clear any floor. Assert the parsed colour is
non-empty before comparing it.

### Not affected

No new always-on column, so `splits.spec.ts`'s pixel constants and the terminal's
leftover width budget are untouched.

## Open questions for planning

1. **Does Lifted chrome's `#060607` canvas need `PANE_COLORS` to gain a darker
   entry?** Its canvas sits below the ramp's current floor, so "put it back" and
   "the darkest available colour" stop being the same swatch under that theme.
2. **Does `--color-inset` earn its place?** Only Line-led uses it, and the edge
   rule currently requires it to be set. If the 1px highlight does not hold up in
   the real app, three things go together: the token, its call sites, and the
   inset clause of the edge rule — leaving Line-led carried by border weight
   alone, at a border floor that would then need re-deriving rather than
   inheriting 20.

## Build order

Each step is separately verifiable, and the first two are invisible on screen:

1. Registry, token declarations, Classic-as-aliases. Nothing changes visually;
   the sync test and the elevation tests for Classic pass.
2. Repoint call sites to `raised` / `overlay` / `border-strong`. Still nothing
   changes visually, because Classic aliases them.
3. Config field, version bump, `additionalArguments` route, `env` bridge
   consolidation, `applyTheme`.
4. The four palettes, with `--color-group` recomputed per theme.
5. Terminal foreground and default background from the registry; live update on
   theme change.
6. Settings Appearance tab and picker.
7. E2E.

Steps 1 and 2 landing with no visual change is the point: if anything moves on
screen before step 4, a call site was repointed wrongly.
