# Dark Theme Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Settings picker offering five dark themes, applied instantly, persisted across launches, and applied before first paint.

**Architecture:** Palettes live in a typed TypeScript registry (`src/shared/themes.ts`) that both the stylesheet and xterm read. `index.css` keeps its `@theme` block purely as the declaration of which tokens exist — Tailwind v4 needs it to emit the utilities — while runtime values are set as inline custom properties on `documentElement`. Four tokens are added (`raised`, `overlay`, `border-strong`, `inset`); Classic defines them as aliases of what those surfaces already use, so the token system lands with no visual change and only the four new themes spend them.

**Tech Stack:** Electron 43, React 19, Tailwind CSS v4, xterm 6, vitest 4, Playwright 1.62, TypeScript 7.

**Spec:** `docs/superpowers/specs/2026-08-09-theme-picker-design.md`

## Global Constraints

- **No em dashes** anywhere: code, comments, copy, commit messages. Use commas, colons, parentheses, or separate sentences.
- **Separation is measured in CIE L\*, not WCAG contrast ratio.** The ratio's +0.05 flare term maps all five palettes onto 1.01 to 1.17 and cannot separate them. Fills are judged by ΔL\*; text keeps the ratio.
- **Fill floor: ΔL\* 3.0.** Applies only to themes declaring `separates: 'fill'`.
- **Edge floor: ΔL\* 20.0.** Applies only to themes declaring `separates: 'edge'`.
- **Text floor: 4.5:1** (WCAG AA) for `label`, `fg`, `muted`, `ok` and `danger` on every ground they land on — for the four NEW themes only. Classic is exempt at `muted`; see Task 1.
- **Terminal floor: 7:1** for `termFg` against the canvas and against every `PANE_COLORS` entry.
- **Classic's palette does not change.** Its hex values are exactly what ships today.
- **`--color-group` is computed, never copied:** `round(0.55 * accent + 0.45 * bg)` per channel, per theme.
- **Every new test must be observed failing before it passes.** Run it, see red. This repo has shipped ten tests that could not fail.
- **Do not transcribe comment text from this plan into the source.** Where a step says a comment is stale, the implementer re-derives it from what is true after their change. Comments asserting a measurement must be measured by the person writing them.

---

## File Structure

**Created:**
- `src/shared/themes.ts` — the five palettes, the token key list, the id guard. Shared because main validates config against it and the renderer paints from it.
- `src/renderer/theme.ts` — `applyTheme` and `bootTheme`. Renderer-only, imports the registry.
- `src/renderer/settings/AppearanceSection.tsx` — the picker.
- `tests/unit/themes.test.ts` — every floor, every theme.
- `tests/unit/themeCss.test.ts` — the registry/`index.css` sync guard.
- `tests/e2e/theme.spec.ts` — switching, persistence, terminal repaint.
- `tests/e2e/colour.ts` — parses `rgb()` from computed styles, computes ΔL\*.

**Modified:**
- `tests/unit/contrast.ts` — gains `lightness` and `lightnessGap`.
- `src/renderer/index.css` — four token declarations, one `.lip` rule.
- `src/renderer/ui/Dialog.tsx`, `src/renderer/IssueModal.tsx`, `src/renderer/FileTreeMenu.tsx`, `src/renderer/Sidebar.tsx`, `src/renderer/TabBar.tsx` — repointed call sites.
- `src/main/state/store.ts` — `theme` field, version 9, `normaliseTheme`.
- `src/shared/ipc.ts` — `theme` / `updateTheme` channels, `env` field.
- `src/main/ipc/register.ts` — the two handlers.
- `src/preload/index.ts` — `env` object replacing `webglLimit`.
- `src/main/index.ts` — `--pterm-theme` in `additionalArguments`.
- `src/renderer/main.tsx` — pre-paint apply.
- `src/renderer/Terminal.tsx` — foreground and default background from the registry.
- `src/renderer/App.tsx` — theme state, passed to `SettingsPane`.
- `src/renderer/settings/tabs.ts`, `src/renderer/settings/SettingsPane.tsx` — the new tab.
- `tests/unit/labelContrast.test.ts` — `AppearanceSection.tsx` added to its regression loop.

---

### Task 1: The theme registry and its floors

Pure data plus tests. Nothing renders differently. This task exists on its own because a palette that fails a floor must be caught before any component depends on it.

**Files:**
- Create: `src/shared/themes.ts`
- Create: `tests/unit/themes.test.ts`
- Modify: `tests/unit/contrast.ts`

**Interfaces:**
- Consumes: `luminance` from `tests/unit/contrast.ts` (existing).
- Produces: `THEME_IDS`, `ThemeId`, `Separation`, `ThemeTokens`, `Theme`, `THEMES`, `THEME_DEFAULT`, `isThemeId(value: unknown): value is ThemeId`, `cssVarName(key: keyof ThemeTokens): string`. Tasks 2 through 8 all import from here.

- [ ] **Step 1: Add the CIE L\* helpers to the contrast module**

In `tests/unit/contrast.ts`, append:

```ts
/**
 * CIE L* lightness, 0 to 100.
 *
 * The contrast ratio above is the wrong instrument for two dark fills abutting:
 * its +0.05 term dominates at low luminance, so every near-black pair collapses
 * toward 1.0 and pure black against #1f1f1f reads as only 1.20:1. L* is a
 * perceptual lightness scale, so the distance between two dark greys is a
 * number that tracks what the eye reports. Text keeps the ratio, which is what
 * the ratio is for.
 */
export function lightness(hex: string): number {
  const y = luminance(hex)
  return y <= 0.008856 ? 903.2963 * y : 116 * Math.cbrt(y) - 16
}

/** Distance in CIE L* between two colours, order independent. */
export function lightnessGap(a: string, b: string): number {
  return Math.abs(lightness(a) - lightness(b))
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/themes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { contrast, lightnessGap } from './contrast'
import { PANE_COLORS } from '../../src/shared/paneColors'
import { THEMES, THEME_IDS, THEME_DEFAULT, isThemeId, cssVarName } from '../../src/shared/themes'

/**
 * Every palette, held to the rule it declares.
 *
 * Two rules rather than one because the five designs do not all separate their
 * surfaces the same way. Four stack planes and are judged on the distance
 * between them. One deliberately does not, separating by border weight and an
 * inset lip instead, and a single flat-fill rule would have failed a design
 * that works. `separates` is what picks the rule, and it is required, so a
 * sixth theme cannot be added without saying how it is meant to be read.
 */

/** Two fills read as separate planes from here up. Below 1 is not visible at all. */
const FILL_FLOOR = 3.0
/** What a border must clear when it is carrying the separation by itself. */
const EDGE_FLOOR = 20.0
/** WCAG AA for normal text. */
const AA = 4.5
/** What the terminal foreground must clear on any background it can be drawn on. */
const TERM_FLOOR = 7

const themes = THEME_IDS.map((id) => THEMES[id])
const fillThemes = themes.filter((t) => t.separates === 'fill')
const edgeThemes = themes.filter((t) => t.separates === 'edge')

describe('the theme registry', () => {
  it('has an entry for every id, keyed by its own id', () => {
    for (const id of THEME_IDS) expect(THEMES[id].id).toBe(id)
  })

  it('defines every token as a parseable hex in every theme', () => {
    const keys = Object.keys(THEMES[THEME_DEFAULT].tokens)
    for (const theme of themes) {
      expect(Object.keys(theme.tokens).sort()).toEqual(keys.sort())
      for (const [key, value] of Object.entries(theme.tokens)) {
        expect(value, `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      }
    }
  })

  it('declares how each theme separates', () => {
    for (const theme of themes) {
      expect(['fill', 'edge', 'baseline']).toContain(theme.separates)
    }
  })

  it('recognises its own ids and nothing else', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true)
    for (const value of ['purple', '', 'CLASSIC', null, 7, undefined]) {
      expect(isThemeId(value)).toBe(false)
    }
  })

  it('maps token keys to the custom property names index.css declares', () => {
    expect(cssVarName('bg')).toBe('--color-bg')
    expect(cssVarName('borderStrong')).toBe('--color-border-strong')
    expect(cssVarName('termFg')).toBe('--color-term-fg')
  })
})

describe('a theme that separates by fill', () => {
  it('clears the fill floor at every step of its ladder', () => {
    for (const { id, tokens } of fillThemes) {
      expect(lightnessGap(tokens.surface, tokens.bg), `${id} surface/bg`).toBeGreaterThanOrEqual(FILL_FLOOR)
      expect(lightnessGap(tokens.raised, tokens.surface), `${id} raised/surface`).toBeGreaterThanOrEqual(FILL_FLOOR)
      expect(lightnessGap(tokens.overlay, tokens.raised), `${id} overlay/raised`).toBeGreaterThanOrEqual(FILL_FLOOR)
    }
  })
})

describe('a theme that separates by edge', () => {
  it('clears the edge floor against its own surface', () => {
    for (const { id, tokens } of edgeThemes) {
      expect(lightnessGap(tokens.border, tokens.surface), `${id} border/surface`).toBeGreaterThanOrEqual(EDGE_FLOOR)
    }
  })

  // Without the lip it is a border and a scrim doing the whole job, which is
  // the version that was rejected. If this token ever goes back to fully
  // transparent, the design it belongs to has quietly become something else.
  it('sets an inset lip rather than leaving it fully transparent', () => {
    for (const { id, tokens } of edgeThemes) {
      expect(tokens.inset, `${id} inset`).not.toMatch(/00$/)
    }
  })
})

describe('the baseline theme', () => {
  const classic = THEMES.classic

  // The recorded defect, asserted so nobody "fixes" it into a fourth stepped
  // theme. Classic is what ships today and changing it is a different decision
  // from adding themes.
  it('is flat, which is the thing the other themes exist to answer', () => {
    expect(classic.separates).toBe('baseline')
    expect(lightnessGap(classic.tokens.surface, classic.tokens.bg)).toBeLessThan(1)
  })

  it('aliases the new tokens onto the surfaces they replace', () => {
    expect(classic.tokens.raised).toBe(classic.tokens.surface)
    expect(classic.tokens.overlay).toBe(classic.tokens.surface)
    expect(classic.tokens.borderStrong).toBe(classic.tokens.faint)
    expect(classic.tokens.inset).toMatch(/00$/)
  })
})

describe('text in every theme', () => {
  it('clears AA for the label colour on both grounds it is drawn on', () => {
    for (const { id, tokens } of themes) {
      expect(contrast(tokens.label, tokens.surface), `${id} label/surface`).toBeGreaterThanOrEqual(AA)
      expect(contrast(tokens.label, tokens.bg), `${id} label/bg`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('clears AA for foreground and semantic colours on every fill', () => {
    for (const { id, tokens } of themes) {
      for (const ground of [tokens.bg, tokens.surface, tokens.raised, tokens.overlay]) {
        expect(contrast(tokens.fg, ground), `${id} fg/${ground}`).toBeGreaterThanOrEqual(AA)
        expect(contrast(tokens.ok, ground), `${id} ok/${ground}`).toBeGreaterThanOrEqual(AA)
        expect(contrast(tokens.danger, ground), `${id} danger/${ground}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  /**
   * `muted` is the one floor Classic does not clear: #71717a on #0c0c0e is
   * 4.04:1, and it ships that way today.
   *
   * `FileTree.tsx` accepted that figure on the grounds that "this background is
   * fixed chrome the user cannot recolour". A theme picker is exactly what
   * falsifies that premise, so the floor is demanded of every theme this
   * feature adds. Classic keeps its value because leaving today's palette
   * untouched is the point of it, and its exemption is pinned to the measured
   * number so it cannot quietly get worse.
   */
  it('clears AA for muted in every theme this feature adds', () => {
    for (const { id, tokens } of themes) {
      if (id === 'classic') continue
      for (const ground of [tokens.bg, tokens.surface, tokens.raised, tokens.overlay]) {
        expect(contrast(tokens.muted, ground), `${id} muted/${ground}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  it('holds Classic muted at the value it shipped with', () => {
    const { muted, surface } = THEMES.classic.tokens
    expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.0)
    expect(contrast(muted, surface)).toBeLessThan(AA)
  })
})

describe('the terminal foreground', () => {
  it('clears AAA on its own canvas and on every pane colour', () => {
    for (const { id, tokens } of themes) {
      expect(contrast(tokens.termFg, tokens.bg), `${id} termFg/canvas`).toBeGreaterThanOrEqual(TERM_FLOOR)
      for (const pane of PANE_COLORS) {
        expect(contrast(tokens.termFg, pane), `${id} termFg/${pane}`).toBeGreaterThanOrEqual(TERM_FLOOR)
      }
    }
  })
})

describe('the tab-group strip colour', () => {
  /** The accent at 55% over the theme's own canvas, per `index.css`. */
  function blend(fg: string, bg: string, alpha: number): string {
    const channel = (at: number): string => {
      const mixed = alpha * parseInt(fg.slice(at, at + 2), 16) + (1 - alpha) * parseInt(bg.slice(at, at + 2), 16)
      return Math.round(mixed).toString(16).padStart(2, '0')
    }
    return `#${channel(1)}${channel(3)}${channel(5)}`
  }

  // Computed rather than picked, which is what `index.css` already says about
  // the shipped value. Carrying one theme's blend into another leaves the strip
  // off-relation to the ground under it, and by eye that is invisible.
  it('is the accent blended over each theme own canvas', () => {
    for (const { id, tokens } of themes) {
      expect(tokens.group, `${id} group`).toBe(blend(tokens.accent, tokens.bg, 0.55))
    }
  })
})
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run tests/unit/themes.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/themes'`.

- [ ] **Step 4: Write the registry**

Create `src/shared/themes.ts`:

```ts
/**
 * Every colour the app draws, five ways.
 *
 * In TypeScript rather than five `:root[data-theme]` blocks in `index.css` for
 * a reason the stylesheet already states: xterm renders to a canvas and cannot
 * read CSS variables, so `Terminal.tsx` has to be handed the values in JS.
 * With the palettes in CSS that hand-copy would have become one per theme.
 * Here the stylesheet and the terminal read the same object.
 *
 * `index.css` still declares each token in its `@theme` block, because Tailwind
 * needs that block to emit `bg-surface` and friends at build time. Those
 * declarations carry Classic's values and are overridden at runtime by
 * `applyTheme`. `tests/unit/themeCss.test.ts` holds the two in step; that test
 * is the only thing guarding the one duplication this design accepts.
 *
 * Shared rather than renderer-only because main validates the stored id
 * against `isThemeId` on the way in, and a second copy of the id list is a
 * copy that can disagree about what a config file may contain.
 */

export const THEME_IDS = ['classic', 'stepped', 'lifted', 'slate', 'lineled'] as const

export type ThemeId = (typeof THEME_IDS)[number]

/**
 * Which rule a theme's separation is judged by.
 *
 * `fill` stacks planes and is measured on the distance between them. `edge`
 * deliberately does not stack, separating by border weight and an inset lip,
 * and is measured on its border instead. `baseline` is Classic, which does
 * neither and is asserted flat on purpose.
 *
 * Required, so that adding a theme forces the question rather than letting it
 * inherit whichever rule happens to run first.
 */
export type Separation = 'fill' | 'edge' | 'baseline'

export interface ThemeTokens {
  /** The canvas: the terminal, and the ground the whole window sits on. */
  bg: string
  /** Chrome: side columns, tab bar, title bar, status bar. */
  surface: string
  /** Selected rows, inputs, wells inside a panel or a dialog. */
  raised: string
  /** Anything that floats: modals, the command palette, context menus. */
  overlay: string
  border: string
  /** The edge of a floating thing, where the ordinary border is too quiet. */
  borderStrong: string
  fg: string
  muted: string
  faint: string
  label: string
  accent: string
  /** The tab bar's split-group strip. Blended, never picked. */
  group: string
  danger: string
  ok: string
  /** xterm's foreground. Read in JS because a canvas cannot read CSS. */
  termFg: string
  /**
   * The 1px lip along the top of a raised surface, as an 8-digit hex so that
   * "no lip" is a colour rather than a special case. Only the edge-separating
   * theme sets a visible one.
   */
  inset: string
}

export interface Theme {
  id: ThemeId
  /** What the picker calls it. */
  name: string
  separates: Separation
  tokens: ThemeTokens
}

/**
 * The custom property a token key is written to.
 *
 * One function rather than a second table: `borderStrong` becoming
 * `--color-border-strong` is a rule, and a table of sixteen pairs is sixteen
 * chances to spell one of them differently from `index.css`.
 */
export function cssVarName(key: keyof ThemeTokens): string {
  return `--color-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

export const THEMES: Record<ThemeId, Theme> = {
  classic: {
    id: 'classic',
    name: 'Classic',
    separates: 'baseline',
    tokens: {
      bg: '#09090b',
      surface: '#0c0c0e',
      raised: '#0c0c0e',
      overlay: '#0c0c0e',
      border: '#27272a',
      borderStrong: '#3f3f46',
      fg: '#fafafa',
      muted: '#71717a',
      faint: '#3f3f46',
      label: '#a1a1aa',
      accent: '#a3e635',
      group: '#5e8322',
      danger: '#f87171',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#00000000',
    },
  },
  stepped: {
    id: 'stepped',
    name: 'Stepped zinc',
    separates: 'fill',
    tokens: {
      bg: '#09090b',
      surface: '#131316',
      raised: '#1b1b1f',
      overlay: '#232328',
      border: '#2c2c31',
      borderStrong: '#43434a',
      fg: '#fafafa',
      muted: '#8a8a93',
      faint: '#4a4a52',
      label: '#b1b1ba',
      accent: '#a3e635',
      group: '#5e8322',
      danger: '#f87171',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#00000000',
    },
  },
  lifted: {
    id: 'lifted',
    name: 'Lifted chrome',
    separates: 'fill',
    tokens: {
      bg: '#060607',
      surface: '#1a1a1e',
      raised: '#232328',
      overlay: '#2c2c33',
      border: '#33333a',
      borderStrong: '#45454e',
      fg: '#f4f4f5',
      muted: '#9a9aa4',
      faint: '#56565f',
      label: '#c4c4cc',
      accent: '#a3e635',
      group: '#5c8120',
      danger: '#f87171',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#00000000',
    },
  },
  slate: {
    id: 'slate',
    name: 'Tinted slate',
    separates: 'fill',
    tokens: {
      bg: '#0a0b10',
      surface: '#12151f',
      raised: '#1a1e2b',
      overlay: '#232839',
      border: '#2b3141',
      borderStrong: '#3b4356',
      fg: '#e8eaf2',
      muted: '#8a94aa',
      faint: '#454e63',
      label: '#b3bccd',
      accent: '#a3e635',
      group: '#5e8324',
      danger: '#fb7185',
      ok: '#4ade80',
      termFg: '#ccd2e0',
      inset: '#00000000',
    },
  },
  lineled: {
    id: 'lineled',
    name: 'Line-led',
    separates: 'edge',
    tokens: {
      bg: '#09090b',
      surface: '#0b0b0d',
      raised: '#101013',
      overlay: '#131316',
      border: '#3f3f46',
      borderStrong: '#57575f',
      fg: '#fafafa',
      muted: '#7d7d87',
      faint: '#4a4a52',
      label: '#a1a1aa',
      accent: '#a3e635',
      group: '#5e8322',
      danger: '#f87171',
      ok: '#4ade80',
      termFg: '#d4d4d8',
      inset: '#ffffff0e',
    },
  },
}

/** What an absent or unrecognised stored id means. */
export const THEME_DEFAULT: ThemeId = 'classic'

/**
 * Whether a value is one of the five.
 *
 * Used on the way IN, in `store.ts`, not only at the picker: config.json is a
 * text file and the renderer is not the only thing that can put a string in
 * that field.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/unit/themes.test.ts`
Expected: PASS, all suites green.

- [ ] **Step 6: Prove the floors can fail**

Temporarily change `THEMES.stepped.tokens.surface` to `'#0a0a0c'` and re-run.
Expected: FAIL on `stepped surface/bg`. Revert.

Temporarily change `THEMES.slate.tokens.group` to `'#5e8322'` and re-run.
Expected: FAIL on `slate group`. Revert.

If either still passes, the assertion is not reading what it claims to. Fix it before continuing.

- [ ] **Step 7: Run the whole unit suite**

Run: `npm test`
Expected: PASS. No existing test touches the new module yet.

- [ ] **Step 8: Commit**

```bash
git add src/shared/themes.ts tests/unit/themes.test.ts tests/unit/contrast.ts
git commit -m "Add the five-palette theme registry and the floors it must clear"
```

---

### Task 2: Declare the four new tokens, with Classic aliasing them

Still invisible. `index.css` gains the declarations Tailwind needs to emit `bg-raised`, `bg-overlay` and `border-border-strong`, plus the `.lip` rule. Because Classic aliases the new tokens onto the old surfaces, nothing on screen moves.

**Files:**
- Modify: `src/renderer/index.css`
- Create: `tests/unit/themeCss.test.ts`

**Interfaces:**
- Consumes: `THEMES`, `THEME_DEFAULT`, `cssVarName`, `ThemeTokens` from Task 1.
- Produces: the utilities `bg-raised`, `bg-overlay`, `border-border-strong`, and the class `.lip`, all used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/themeCss.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { THEMES, THEME_DEFAULT, cssVarName, type ThemeTokens } from '../../src/shared/themes'

/**
 * The one duplication this design accepts, guarded.
 *
 * Tailwind v4 needs every token declared in `@theme` at build time or the
 * utility that references it is never emitted, so `index.css` has to carry a
 * literal value for each. The runtime values come from the registry, which
 * means Classic's palette exists in two files. This test is what stops them
 * drifting: a hex changed in one place and not the other would leave the app
 * painting one palette before `applyTheme` runs and another after.
 */

const CSS = readFileSync(new URL('../../src/renderer/index.css', import.meta.url), 'utf8')

/** Reads a `--color-x: #rrggbb;` or `#rrggbbaa` declaration out of the file. */
function declared(property: string): string | null {
  const found = new RegExp(`${property}:\\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)\\s*;`).exec(CSS)
  return found ? found[1].toLowerCase() : null
}

describe('index.css and the theme registry', () => {
  const tokens = THEMES[THEME_DEFAULT].tokens

  it('declares every token the registry defines', () => {
    for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
      expect(declared(cssVarName(key)), `${cssVarName(key)} missing from index.css`).not.toBeNull()
    }
  })

  it('declares them with the default theme own values', () => {
    for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
      expect(declared(cssVarName(key)), cssVarName(key)).toBe(tokens[key].toLowerCase())
    }
  })

  // The lip is the edge-separating theme whole mechanism. A rule that reads
  // any other property would leave that theme with nothing but a border.
  it('draws the inset lip from the token', () => {
    expect(CSS).toMatch(/\.lip\s*\{[^}]*box-shadow:\s*inset 0 1px 0 var\(--color-inset\)/)
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/themeCss.test.ts`
Expected: FAIL — `--color-raised missing from index.css`.

- [ ] **Step 3: Add the declarations to the `@theme` block**

In `src/renderer/index.css`, inside `@theme`, after the `--color-surface` line, add:

```css
  /* Declared here because Tailwind v4 emits a utility only for a token it can
     see at build time, and overridden at runtime by `applyTheme`. The values
     below are the default theme's, held equal to `THEMES.classic` by
     `tests/unit/themeCss.test.ts`.

     `raised` and `overlay` are aliases of `surface` in this theme, which is
     what makes introducing them change nothing on screen. The themes that
     spend them are the ones that give them distinct values. */
  --color-raised: #0c0c0e;
  --color-overlay: #0c0c0e;
```

After the `--color-faint` line, add:

```css
  --color-border-strong: #3f3f46;
```

After the `--color-term-fg` line, add:

```css
  /* Eight digits so that "no lip" is a colour rather than a branch. Fully
     transparent here; only the theme that separates by edge sets a visible
     one. */
  --color-inset: #00000000;
```

- [ ] **Step 4: Add the lip rule**

At the end of `src/renderer/index.css`, add:

```css
/* The 1px highlight along the top edge of a raised surface.

   A class rather than a utility at each call site because it is one declaration
   with one meaning, and because a theme that sets `--color-inset` transparent
   gets a box-shadow that paints nothing, which costs less than every panel
   branching on the theme. */
.lip {
  box-shadow: inset 0 1px 0 var(--color-inset);
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/unit/themeCss.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the sync guard can fail**

Temporarily change `--color-raised` in `index.css` to `#0c0c0f` and re-run.
Expected: FAIL on `--color-raised`. Revert.

- [ ] **Step 7: Confirm nothing on screen changed**

Run: `npm start`

Look at the app. Nothing should differ from before this task: no panel, dialog or row has changed colour, because no component references the new tokens yet. If anything moved, a declaration overwrote an existing token rather than adding a new one.

Quit the app.

- [ ] **Step 8: Run the full unit suite**

Run: `npm test`
Expected: PASS, including `labelContrast.test.ts`, which reads this same file.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/index.css tests/unit/themeCss.test.ts
git commit -m "Declare the raised, overlay, border-strong and inset tokens"
```

---

### Task 3: Repoint the call sites that mean raised or floating

The mechanical half of the work, and still invisible: Classic aliases every new token onto the value the call site already used, so the rendered output is byte-identical.

`bg-bg` currently does double duty as "the canvas" and "this row is selected". Those are different intents sharing a hex, and a theme where the canvas is darker than the chrome breaks them apart. Splitting them is the point of this task.

**Files:**
- Modify: `src/renderer/ui/Dialog.tsx:20`
- Modify: `src/renderer/IssueModal.tsx:89`
- Modify: `src/renderer/FileTreeMenu.tsx:69`
- Modify: `src/renderer/Sidebar.tsx:140,167,195,297`
- Modify: `src/renderer/TabBar.tsx:202,246,270`

**Interfaces:**
- Consumes: `bg-raised`, `bg-overlay`, `border-border-strong` from Task 2.
- Produces: nothing importable. Later tasks depend on these call sites reading the right token, not on any new export.

`CommandPalette.tsx` and `settings/SettingsPane.tsx` need no edit: both render through `DialogContent`, so the `Dialog.tsx` change covers them. `HistoryOverlay.tsx:159` also needs no edit: despite its name it is a strip attached to the bottom of a pane, not a floating surface, so `bg-surface` is correct for it.

- [ ] **Step 1: Repoint the dialog shell**

In `src/renderer/ui/Dialog.tsx`, change line 20 from:

```tsx
          'rounded border border-border bg-surface p-4 font-mono text-fg shadow-xl',
```

to:

```tsx
          'lip rounded border border-border-strong bg-overlay p-4 font-mono text-fg shadow-xl',
```

- [ ] **Step 2: Repoint the modal's body well**

In `src/renderer/IssueModal.tsx`, change line 89 from:

```tsx
      className="scroll-thin mb-3 border border-border bg-bg"
```

to:

```tsx
      className="scroll-thin mb-3 border border-border bg-raised"
```

- [ ] **Step 3: Repoint the file tree's context menu**

In `src/renderer/FileTreeMenu.tsx`, change line 69 from:

```tsx
        'fixed z-50 min-w-[160px] rounded border border-border bg-surface py-1 font-sans text-[12px] shadow-lg',
```

to:

```tsx
        'fixed z-50 min-w-[160px] rounded border border-border-strong bg-overlay py-1 font-sans text-[12px] shadow-lg',
```

- [ ] **Step 4: Repoint the sidebar's four sites**

In `src/renderer/Sidebar.tsx`:

Line 140, a selected project row, from:

```tsx
                  active ? 'bg-bg text-fg' : 'text-muted hover:text-fg',
```

to:

```tsx
                  active ? 'bg-raised text-fg' : 'text-muted hover:text-fg',
```

Line 167, a rename input, from:

```tsx
                    className="min-w-0 flex-1 border border-border bg-bg px-1 text-fg outline-none"
```

to:

```tsx
                    className="min-w-0 flex-1 border border-border bg-raised px-1 text-fg outline-none"
```

Line 195, the project context menu, from:

```tsx
                <div className="flex flex-col border-y border-border bg-bg py-0.5">
```

to:

```tsx
                <div className="flex flex-col border-y border-border-strong bg-overlay py-0.5">
```

Line 297, a small inline control, from:

```tsx
                          className="cursor-default border border-border bg-bg text-[10px] text-muted"
```

to:

```tsx
                          className="cursor-default border border-border bg-raised text-[10px] text-muted"
```

- [ ] **Step 5: Repoint the tab bar's three sites**

In `src/renderer/TabBar.tsx`:

Line 202, the active tab, **stays `bg-bg`**. An active tab is continuous with the terminal below it: the fill running from tab into canvas is what makes it read as the front one, and under Lifted chrome that continuity is the whole effect. Leave it, and make sure the next reader knows it was considered rather than missed.

Line 246, a rename input, from:

```tsx
                className="min-w-0 flex-1 border border-border bg-bg px-1 text-fg outline-none"
```

to:

```tsx
                className="min-w-0 flex-1 border border-border bg-raised px-1 text-fg outline-none"
```

Line 270, the tab context menu, from:

```tsx
                className="fixed z-20 flex flex-col border border-border bg-bg py-0.5 text-[11px]"
```

to:

```tsx
                className="fixed z-20 flex flex-col border border-border-strong bg-overlay py-0.5 text-[11px]"
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Confirm nothing on screen changed**

Run: `npm start`

Open a modal (⌘, for Settings), a context menu (right-click a file in the Files column, and the ⋯ on a project row), and select a project. Every one of those should look exactly as it did before this task, because Classic aliases the tokens you just pointed them at.

Anything that looks different means a call site was pointed at a token Classic does not alias to the old value. Quit the app.

- [ ] **Step 8: Run the full suites**

Run: `npm test`
Expected: PASS.

Run: `npx playwright test`
Expected: PASS. No test asserts these class names, but several click through these menus.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/ui/Dialog.tsx src/renderer/IssueModal.tsx src/renderer/FileTreeMenu.tsx src/renderer/Sidebar.tsx src/renderer/TabBar.tsx
git commit -m "Point floating and raised surfaces at their own tokens"
```

---

### Task 4: Persist the chosen theme

**Files:**
- Modify: `src/main/state/store.ts:35-49,69-76,366-412`
- Modify: `src/shared/ipc.ts` (CHANNELS around line 34, `PTermApi` around line 938)
- Modify: `src/main/ipc/register.ts:1348-1359`
- Modify: `src/preload/index.ts:74-75`
- Create: `tests/unit/themeStore.test.ts`

**Interfaces:**
- Consumes: `ThemeId`, `isThemeId`, `THEME_DEFAULT` from Task 1.
- Produces: `PTermConfig.theme: ThemeId`; `window.pterm.theme(): Promise<ThemeId>`; `window.pterm.updateTheme(id: ThemeId): Promise<ThemeId>`; `CHANNELS.theme`, `CHANNELS.updateTheme`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/themeStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { migrate } from '../../src/main/state/store'

/**
 * The stored theme, read defensively.
 *
 * config.json is a text file. A hand-edited id that is not one of the five
 * must land on the default rather than reaching `applyTheme` and leaving the
 * window painted in nothing, which is the same tolerance every other field in
 * this file already has.
 */

describe('reading the theme out of a config file', () => {
  it('takes a recognised id', () => {
    expect(migrate({ version: 9, theme: 'stepped' }).theme).toBe('stepped')
  })

  it('defaults a v8 file, which had no theme field', () => {
    expect(migrate({ version: 8 }).theme).toBe('classic')
  })

  it('defaults a v1 file too', () => {
    expect(migrate({ version: 1 }).theme).toBe('classic')
  })

  it('defaults an unrecognised id rather than passing it through', () => {
    expect(migrate({ version: 9, theme: 'purple' }).theme).toBe('classic')
    expect(migrate({ version: 9, theme: 7 }).theme).toBe('classic')
    expect(migrate({ version: 9, theme: null }).theme).toBe('classic')
  })

  it('writes version 9', () => {
    expect(migrate({ version: 8 }).version).toBe(9)
    expect(migrate({ version: 9, theme: 'slate' }).version).toBe(9)
  })
})
```

If `migrate` is not currently exported from `store.ts`, export it in Step 3. It is pure and this is the only way to test the migration without a filesystem.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/themeStore.test.ts`
Expected: FAIL — either `migrate is not a function` or `theme` is undefined.

- [ ] **Step 3: Add the field, the guard, and the version**

In `src/main/state/store.ts`:

Add to the imports at the top:

```ts
import { isThemeId, THEME_DEFAULT, type ThemeId } from '../../shared/themes'
```

In `PTermConfig`, change `version: 8` to `version: 9` and add after `notifications`:

```ts
  /** Which palette the window paints in. See `src/shared/themes.ts`. */
  theme: ThemeId
```

In `EMPTY`, change `version: 8` to `version: 9` and add `theme: THEME_DEFAULT,`.

Add beside the other normalisers, before `migrate`:

```ts
/**
 * The stored theme id, or the default.
 *
 * Same shape as `normaliseNotifications` and for the same reason: a field read
 * out of a text file is a field that can be anything, and the cost of trusting
 * this one is a window painted from an undefined palette.
 */
function normaliseTheme(value: unknown): ThemeId {
  return isThemeId(value) ? value : THEME_DEFAULT
}
```

In `migrate`, add `theme?: unknown` to the `candidate` type. Change the branch condition to include 9, and both returns to write version 9 and a theme:

```ts
  if (
    value.version === 5 ||
    value.version === 6 ||
    value.version === 7 ||
    value.version === 8 ||
    value.version === 9
  ) {
    const panes = paneRows(candidate.panes)
    return {
      version: 9,
      projects,
      activeProjectId,
      panes,
      tabs: tabRows(candidate.tabs, panes),
      notifications: normaliseNotifications(candidate.notifications),
      theme: normaliseTheme(candidate.theme),
    }
  }
  if ([1, 2, 3, 4].includes(value.version)) {
    const panes = paneRows(candidate.tabs)
    return {
      version: 9,
      projects,
      activeProjectId,
      panes,
      tabs: oneTabPerPane(panes),
      notifications: normaliseNotifications(candidate.notifications),
      theme: normaliseTheme(candidate.theme),
    }
  }
```

Export `migrate` if it is not already exported: change `function migrate(` to `export function migrate(`.

The comment above `migrate` explains which versions share a shape and why. v9 adds an optional field that an older file simply lacks, which is what "never set" already means, so it joins the same branch. Re-derive that comment's wording yourself rather than copying this paragraph into it.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/themeStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the channels**

In `src/shared/ipc.ts`, in `CHANNELS`, after `updateNotifications`:

```ts
  theme: 'pterm:theme',
  updateTheme: 'pterm:updateTheme',
```

In `PTermApi`, after `updateNotifications`:

```ts
  /** The stored theme id. */
  theme(): Promise<ThemeId>
  /** Stores `id` and returns what was stored. */
  updateTheme(id: ThemeId): Promise<ThemeId>
```

Add `import type { ThemeId } from './themes'` at the top of the file if no theme import exists yet.

- [ ] **Step 6: Add the handlers**

In `src/main/ipc/register.ts`, after the `updateNotifications` handler at line 1359:

```ts
  ipcMain.handle(CHANNELS.theme, async () => (await store.read()).theme)

  ipcMain.handle(CHANNELS.updateTheme, (_event, id: ThemeId): Promise<ThemeId> =>
    serialise(async () => {
      const config = await store.read()
      // Through the same queue every other config write uses. Two writes racing
      // on this file is how a theme change loses a tab row written a
      // millisecond earlier.
      const theme = isThemeId(id) ? id : config.theme
      await store.write({ ...config, theme })
      return theme
    }),
  )
```

Add `import { isThemeId, type ThemeId } from '../../shared/themes'` to the file's imports.

- [ ] **Step 7: Add the preload methods**

In `src/preload/index.ts`, after line 75:

```ts
  theme: () => ipcRenderer.invoke(CHANNELS.theme),
  updateTheme: (id) => ipcRenderer.invoke(CHANNELS.updateTheme, id),
```

- [ ] **Step 8: Typecheck and run everything**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS. Any existing store test asserting `version: 8` needs updating to 9; that is a real assertion about the written file, so change the number rather than loosening the check.

- [ ] **Step 9: Prove the guard can fail**

Temporarily change `normaliseTheme` to `return value as ThemeId`.
Run: `npx vitest run tests/unit/themeStore.test.ts`
Expected: FAIL on the unrecognised-id cases. Revert.

- [ ] **Step 10: Commit**

```bash
git add src/main/state/store.ts src/shared/ipc.ts src/main/ipc/register.ts src/preload/index.ts tests/unit/themeStore.test.ts
git commit -m "Store the chosen theme in config version 9"
```

---

### Task 5: Apply the theme before the first frame

**Files:**
- Create: `src/renderer/theme.ts`
- Modify: `src/main/index.ts:465-468` and the `app.whenReady` block around line 536
- Modify: `src/preload/index.ts:182-191`
- Modify: `src/shared/ipc.ts` (the `webglLimit` field)
- Modify: `src/renderer/main.tsx`
- Modify: every existing `webglLimit` reader
- Create: `tests/unit/themeApply.test.ts`

**Interfaces:**
- Consumes: `THEMES`, `cssVarName`, `isThemeId`, `THEME_DEFAULT`, `ThemeId` from Task 1; `window.pterm.env` from this task.
- Produces: `applyTheme(id: ThemeId): void`, `bootTheme(): ThemeId` from `src/renderer/theme.ts`; `window.pterm.env: { webglLimit?: string; theme?: string }`.

`webglLimit` is currently the only non-function member of `PTermApi`. Adding a second loose value beside it is the moment to fold both into one object, so the next startup-time value does not widen the API again.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/themeApply.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { THEMES, cssVarName, type ThemeTokens } from '../../src/shared/themes'
import { themeProperties } from '../../src/renderer/theme'

/**
 * The token-to-property mapping, tested without a DOM.
 *
 * `vitest.config.ts` runs in the node environment, so `applyTheme` itself
 * cannot be called here. The part worth testing is which properties it would
 * set to which values, so that computation is a separate exported function and
 * `applyTheme` is the two lines that hand it to `documentElement`.
 */

describe('the properties a theme sets', () => {
  it('covers every token', () => {
    const props = themeProperties('stepped')
    const keys = Object.keys(THEMES.stepped.tokens) as (keyof ThemeTokens)[]
    expect(Object.keys(props)).toHaveLength(keys.length)
    for (const key of keys) {
      expect(props[cssVarName(key)]).toBe(THEMES.stepped.tokens[key])
    }
  })

  it('uses the custom property names index.css declares', () => {
    const props = themeProperties('lifted')
    expect(props['--color-bg']).toBe('#060607')
    expect(props['--color-border-strong']).toBe('#45454e')
    expect(props['--color-term-fg']).toBe('#d4d4d8')
  })

  it('gives the edge-separating theme a visible lip', () => {
    expect(themeProperties('lineled')['--color-inset']).toBe('#ffffff0e')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/themeApply.test.ts`
Expected: FAIL — `Cannot find module '../../src/renderer/theme'`.

- [ ] **Step 3: Write the apply module**

Create `src/renderer/theme.ts`:

```ts
import { THEMES, THEME_DEFAULT, cssVarName, isThemeId, type ThemeId, type ThemeTokens } from '../shared/themes'

/**
 * Painting the window in one of the five palettes.
 *
 * Set as inline custom properties on `documentElement` rather than by swapping
 * a stylesheet: an inline property beats `@theme`'s `:root` on specificity
 * without needing `!important`, and every Tailwind utility already resolves
 * through `var(--color-*)`, so one assignment repaints everything that
 * references it.
 *
 * `data-theme` is set alongside for anything that needs to branch on the theme
 * in CSS rather than read a token, and so that a screenshot or a devtools
 * inspection says which palette it is looking at.
 */

/** Which properties a theme sets, and to what. Separated so it is testable without a DOM. */
export function themeProperties(id: ThemeId): Record<string, string> {
  const { tokens } = THEMES[id]
  const out: Record<string, string> = {}
  for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    out[cssVarName(key)] = tokens[key]
  }
  return out
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement
  root.dataset.theme = id
  for (const [property, value] of Object.entries(themeProperties(id))) {
    root.style.setProperty(property, value)
  }
}

/**
 * The theme to paint before React mounts.
 *
 * Off the command line rather than over IPC because IPC is a round trip and
 * this has to happen before the first frame. Settings otherwise arrive
 * asynchronously, which would paint the default palette and then swap on every
 * launch, on a window full of terminals.
 */
export function bootTheme(): ThemeId {
  const stored = window.pterm?.env?.theme
  return isThemeId(stored) ? stored : THEME_DEFAULT
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/themeApply.test.ts`
Expected: PASS.

- [ ] **Step 5: Fold `webglLimit` into an `env` object**

In `src/shared/ipc.ts`, replace the `webglLimit` field on `PTermApi` with:

```ts
  /**
   * Values the main process puts on the command line at window creation,
   * readable synchronously before the first frame.
   *
   * An object rather than a field each: these are read once, at startup, by
   * code that cannot wait for a round trip, and a flat field per value grows
   * the bridge every time another one is needed. Both members are optional
   * because neither is always set.
   */
  env: { webglLimit?: string; theme?: string }
```

In `src/preload/index.ts`, replace the `webglLimit` member (lines 182-190) with:

```ts
  // Off `process.argv`, not `process.env`: vite compiles this bundle with
  // `process.env` replaced by an empty object literal, so reading a variable
  // here would be statically undefined and silently do nothing. `createWindow`
  // in `src/main/index.ts` puts these on the command line for exactly that
  // reason, and its comment is the long version.
  env: {
    webglLimit: argValue('--pterm-webgl-limit='),
    theme: argValue('--pterm-theme='),
  },
```

and add above the `api` object:

```ts
/** The value of a `--flag=value` argument, or undefined if it was not passed. */
function argValue(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}
```

- [ ] **Step 6: Update every `webglLimit` reader**

Run: `grep -rn "webglLimit" src/ tests/`

Every read of `window.pterm.webglLimit` becomes `window.pterm.env.webglLimit`. Change each one.

Run: `npm run typecheck`
Expected: PASS. A miss here is a type error, not a silent break.

- [ ] **Step 7: Pass the theme on the command line**

In `src/main/index.ts`, add near the other module-level state:

```ts
/**
 * The stored theme, read once at startup so `createWindow` can pass it
 * synchronously. `createWindow` is called from three places including
 * `activate` and `second-instance`, and making it async to await a config read
 * would put a window creation behind a promise in all three.
 */
let bootTheme: ThemeId = THEME_DEFAULT
```

with `import { THEME_DEFAULT, type ThemeId } from '../shared/themes'` added to the imports.

Change `additionalArguments` (lines 465-468) to:

```ts
      additionalArguments: [
        ...(process.env.PTERM_WEBGL_LIMIT === undefined
          ? []
          : [`--pterm-webgl-limit=${process.env.PTERM_WEBGL_LIMIT}`]),
        `--pterm-theme=${bootTheme}`,
      ],
```

In the `app.whenReady` block, immediately before the existing `createWindow()` call at line 536:

```ts
  bootTheme = (await store.read()).theme
```

- [ ] **Step 8: Apply it before React mounts**

Replace `src/renderer/main.tsx` with:

```tsx
import './index.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme, bootTheme } from './theme'

// Before `createRoot`, deliberately. React's first paint has to land on the
// stored palette: applying it after mount would show the default theme for a
// frame on every launch, and the app opens onto a window full of terminals.
applyTheme(bootTheme())

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')
createRoot(el).render(<App />)
```

- [ ] **Step 9: Verify it end to end by hand**

Run: `npm start`, quit.

Edit `~/.pterm/config.json` (or `$PTERM_CONFIG_DIR/config.json`) and set `"theme": "lifted"`.

Run: `npm start`

The whole shell should be visibly lighter than the terminal, from the first frame. Watch the launch closely: there must be no moment where the app paints dark chrome and then lifts.

Set it back to `"classic"` and relaunch to confirm it returns.

- [ ] **Step 10: Run everything**

Run: `npm test`
Expected: PASS.

Run: `npx playwright test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/theme.ts src/renderer/main.tsx src/main/index.ts src/preload/index.ts src/shared/ipc.ts tests/unit/themeApply.test.ts
git commit -m "Apply the stored theme before the first frame"
```

Include in this commit any file changed by Step 6.

---

### Task 6: The terminal reads its colours from the registry

Until now xterm has been constructed with a hardcoded foreground and a default background that assumes Classic's canvas. Both become registry reads, and the live-update effect widens to carry a theme change.

**Files:**
- Modify: `src/renderer/Terminal.tsx:344-353,514-525`
- Create: `tests/unit/terminalTheme.test.ts`

**Interfaces:**
- Consumes: `THEMES`, `ThemeId` from Task 1; `applyTheme` from Task 5.
- Produces: `xtermTheme(id: ThemeId, paneColor: string | undefined): { background: string; foreground: string }` exported from `Terminal.tsx`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/terminalTheme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { THEMES } from '../../src/shared/themes'
import { xtermTheme } from '../../src/renderer/Terminal'

/**
 * What xterm is handed, computed as a pure function so it can be tested
 * without mounting a terminal.
 *
 * The distinction that matters is between a pane with a colour of its own and
 * a pane without one. An uncoloured pane follows the theme's canvas, which is
 * what makes switching to a theme with a different canvas repaint every
 * default pane. A coloured pane keeps its colour, because the user set it.
 */

describe('the theme xterm is constructed with', () => {
  it('takes the theme own canvas when the pane has no colour', () => {
    expect(xtermTheme('lifted', undefined).background).toBe(THEMES.lifted.tokens.bg)
    expect(xtermTheme('classic', undefined).background).toBe(THEMES.classic.tokens.bg)
  })

  it('keeps a pane own colour, whatever the theme', () => {
    expect(xtermTheme('lifted', '#232326').background).toBe('#232326')
    expect(xtermTheme('slate', '#232326').background).toBe('#232326')
  })

  it('takes the foreground from the theme rather than a constant', () => {
    expect(xtermTheme('slate', undefined).foreground).toBe(THEMES.slate.tokens.termFg)
    expect(xtermTheme('classic', undefined).foreground).toBe('#d4d4d8')
  })

  // Slate is the theme that moves the foreground. If these two ever match, the
  // foreground has stopped being read per theme and the test above is passing
  // on a coincidence.
  it('gives different themes different foregrounds', () => {
    expect(xtermTheme('slate', undefined).foreground).not.toBe(
      xtermTheme('classic', undefined).foreground,
    )
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/terminalTheme.test.ts`
Expected: FAIL — `xtermTheme` is not exported.

- [ ] **Step 3: Add the pure function**

In `src/renderer/Terminal.tsx`, near the top after the imports:

```ts
import { THEMES, type ThemeId } from '../shared/themes'

/**
 * The colours xterm is handed for a pane.
 *
 * A function rather than two inline reads because xterm renders to a canvas
 * and cannot read the custom properties the rest of the app is painted from,
 * so these two values are the one place the palette is duplicated out of CSS.
 * Keeping the duplication in a single tested function is what stops it drifting
 * the way the hardcoded `#d4d4d8` it replaces could.
 *
 * `paneColor` undefined means the pane has no colour of its own, which is
 * stored as an absent field rather than as the canvas hex. That is what lets
 * a default pane follow the theme.
 */
export function xtermTheme(
  id: ThemeId,
  paneColor: string | undefined,
): { background: string; foreground: string } {
  const { tokens } = THEMES[id]
  return { background: paneColor ?? tokens.bg, foreground: tokens.termFg }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/terminalTheme.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it at construction**

The component needs the current theme. Take it as a prop, `theme: ThemeId`, added to the component's props type alongside `color`.

Replace line 352:

```ts
      theme: { background: color, foreground: '#d4d4d8' },
```

with:

```ts
      theme: xtermTheme(theme, paneColor),
```

where `paneColor` is the pane's own colour or `undefined`. If the component currently receives `color` already defaulted to `#09090b`, thread the undefined-able value through instead: a pre-defaulted colour cannot follow the theme, which is the bug this task exists to avoid.

Update the comment above it. It currently says the foreground repeats `--color-term-fg` by hand and names the constant. That is no longer true, and the reason the value is duplicated out of CSS at all has changed. Re-derive it.

- [ ] **Step 6: Widen the live-update effect**

Replace the effect at lines 521-525:

```ts
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = { ...term.options.theme, background: color }
  }, [color])
```

with:

```ts
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = { ...term.options.theme, ...xtermTheme(theme, paneColor) }
  }, [theme, paneColor])
```

The comment above it explains why this is a settable option rather than a rebuild, and that reason is unchanged. What has changed is that it now carries two values and two triggers. Extend the comment accordingly, in your own words.

- [ ] **Step 7: Pass the theme down**

In `src/renderer/App.tsx`, hold the theme in state, initialised from `bootTheme()`, and pass it to every `Terminal`. The value is already applied to the document by `main.tsx`; this state is what React renders from.

```tsx
const [theme, setTheme] = useState<ThemeId>(() => bootTheme())
```

with `import { bootTheme } from './theme'` and `import type { ThemeId } from '../shared/themes'`.

- [ ] **Step 8: Verify by hand**

Run: `npm start`

Open two panes. Set one to a colour with the pane colour picker, leave the other default. Quit, set `"theme": "slate"` in config.json, relaunch.

Expected: the uncoloured pane's background is Slate's `#0a0b10` and its text is the slightly cooler `#ccd2e0`. The coloured pane keeps the colour you set. Both are legible.

- [ ] **Step 9: Run everything**

Run: `npm test`
Expected: PASS.

Run: `npx playwright test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/Terminal.tsx src/renderer/App.tsx tests/unit/terminalTheme.test.ts
git commit -m "Read the terminal foreground and default background from the theme"
```

---

### Task 7: The Appearance tab and its picker

**Files:**
- Modify: `src/renderer/settings/tabs.ts:7-12`
- Create: `src/renderer/settings/AppearanceSection.tsx`
- Modify: `src/renderer/settings/SettingsPane.tsx:11-21,60-79`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/unit/labelContrast.test.ts:98-104`
- Create: `tests/unit/appearanceTabs.test.ts`

**Interfaces:**
- Consumes: `THEMES`, `THEME_IDS`, `ThemeId` from Task 1; `applyTheme` from Task 5; `window.pterm.updateTheme` from Task 4; `nextTabIndex` from `settings/tabs.ts` (existing).
- Produces: `AppearanceSection({ theme, onThemeChange }: { theme: ThemeId; onThemeChange: (id: ThemeId) => void })`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/appearanceTabs.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { SETTINGS_TABS } from '../../src/renderer/settings/tabs'
import { THEME_IDS } from '../../src/shared/themes'

describe('the settings tab strip', () => {
  // The pane opens on the first entry, so this is what decides that opening
  // settings lands on a live theme picker.
  it('leads with appearance', () => {
    expect(SETTINGS_TABS[0].id).toBe('appearance')
  })

  it('keeps the four that were there', () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id)
    for (const id of ['notifications', 'hooks', 'shell-history', 'updates']) {
      expect(ids).toContain(id)
    }
  })

  // Terminal tabs are counted in 27 or more e2e locators by the prefix
  // `tab-`. A settings tab testid starting with `settings-` cannot be caught by
  // that selector, and this is what stops a later rename walking into it.
  it('namespaces its testids away from the terminal tab prefix', () => {
    const source = readFileSync(
      new URL('../../src/renderer/settings/SettingsTabs.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('data-testid={`settings-tab-${tab.id}`}')
  })
})

describe('the picker', () => {
  const source = readFileSync(
    new URL('../../src/renderer/settings/AppearanceSection.tsx', import.meta.url),
    'utf8',
  )

  it('offers every theme rather than a hardcoded list', () => {
    expect(source).toContain('THEME_IDS')
  })

  it('gives each card a testid derived from the id', () => {
    expect(source).toContain('data-testid={`theme-${id}`}')
  })

  // The regression `labelContrast.test.ts` exists to catch, checked here too
  // because this file is new and that loop is a list of names.
  it('does not draw text in the colour that measured 1.86:1', () => {
    expect(source).not.toContain('text-faint')
  })

  it('marks the chosen card for assistive technology, not only visually', () => {
    expect(source).toContain('role="radiogroup"')
    expect(source).toContain('aria-checked')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/appearanceTabs.test.ts`
Expected: FAIL — `SETTINGS_TABS[0].id` is `notifications`, and the section file does not exist.

- [ ] **Step 3: Add the tab**

In `src/renderer/settings/tabs.ts`, change the array to:

```ts
export const SETTINGS_TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'shell-history', label: 'Shell history' },
  { id: 'updates', label: 'Updates' },
] as const
```

The doc comment above it explains the ordering, and says Notifications leads because it is the only one of **four** a user changes more than once, the others being one-time installs. A fifth tab makes that false in two ways. Rewrite it to state the ordering that is now true and why, from your own reading of the tabs. Do not copy wording from this plan into it.

- [ ] **Step 4: Write the picker**

Create `src/renderer/settings/AppearanceSection.tsx`:

```tsx
import { useRef } from 'react'
import { cn } from '../lib/cn'
import { THEMES, THEME_IDS, type ThemeId } from '../../shared/themes'

/**
 * The theme picker: five cards, applied on click.
 *
 * No Save button and no preview thumbnail, because the app is the preview. A
 * click repaints the whole window, and this pane is itself a dialog over the
 * shell, so one click shows the modal treatment, the panel treatment and the
 * terminal at once. Those are the three surfaces the themes exist to separate.
 *
 * The swatch strip on each card is the theme's four fills in order, canvas
 * first. It is there to identify a palette, not to preview it: the preview is
 * the window behind this dialog.
 */
export function AppearanceSection({
  theme,
  onThemeChange,
}: {
  theme: ThemeId
  onThemeChange: (id: ThemeId) => void
}) {
  const cards = useRef<Partial<Record<ThemeId, HTMLButtonElement | null>>>({})
  const index = THEME_IDS.indexOf(theme)

  // Arrow keys move within the group and select as they go, which is what a
  // radiogroup does. Selecting on move is right here in a way it would not be
  // elsewhere: applying is instant and reversible, so arrowing through the
  // five is the fastest way to compare them.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : 0
    if (delta === 0) return
    event.preventDefault()
    const next = THEME_IDS[(index + delta + THEME_IDS.length) % THEME_IDS.length]
    onThemeChange(next)
    cards.current[next]?.focus()
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Theme"
        data-testid="theme-picker"
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-2"
      >
        {THEME_IDS.map((id) => {
          const { name, tokens } = THEMES[id]
          const chosen = id === theme
          return (
            <button
              key={id}
              ref={(node) => {
                cards.current[id] = node
              }}
              type="button"
              role="radio"
              aria-checked={chosen}
              tabIndex={chosen ? 0 : -1}
              data-testid={`theme-${id}`}
              onClick={() => onThemeChange(id)}
              className={cn(
                'flex w-[104px] cursor-default flex-col gap-1.5 rounded border bg-raised p-2 text-left',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                chosen ? 'border-accent' : 'border-border hover:border-border-strong',
              )}
            >
              <span className="flex overflow-hidden rounded-sm border border-border">
                {[tokens.bg, tokens.surface, tokens.raised, tokens.overlay].map((fill, at) => (
                  <span key={at} className="h-4 flex-1" style={{ background: fill }} />
                ))}
              </span>
              <span className={cn('text-[11px]', chosen ? 'text-fg' : 'text-label')}>{name}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-label">
        Applies straight away. Terminals keep any colour you set on them.
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Mount it**

In `src/renderer/settings/SettingsPane.tsx`, add to the props:

```tsx
  theme: ThemeId
  onThemeChange: (id: ThemeId) => void
```

with `import type { ThemeId } from '../../shared/themes'` and `import { AppearanceSection } from './AppearanceSection'`.

Add to the panel body, before the notifications branch:

```tsx
          {tab === 'appearance' ? (
            <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
          ) : null}
```

- [ ] **Step 6: Wire it to state and to disk**

In `src/renderer/App.tsx`, add the handler beside the theme state added in Task 6:

```tsx
  // Applied first, stored second. The write is a round trip and the click has
  // to feel instant; if the write fails the palette on screen is still the one
  // the user asked for, and the stored value is corrected on the next change.
  const onThemeChange = useCallback((id: ThemeId) => {
    setTheme(id)
    applyTheme(id)
    window.pterm.updateTheme(id).catch(() => undefined)
  }, [])
```

with `applyTheme` added to the existing `./theme` import. Pass `theme` and `onThemeChange` to `SettingsPane`.

- [ ] **Step 7: Add the new file to the label-colour regression loop**

In `tests/unit/labelContrast.test.ts`, add `'AppearanceSection.tsx',` to the array at lines 98-104.

- [ ] **Step 8: Run the test and watch it pass**

Run: `npx vitest run tests/unit/appearanceTabs.test.ts tests/unit/labelContrast.test.ts`
Expected: PASS.

- [ ] **Step 9: Verify by hand, which is the point of this feature**

Run: `npm start`

Press ⌘, to open Settings. It must open on Appearance.

Click each of the five cards in turn. Watch, specifically:
- the dialog you are looking at lifting away from the page behind it
- the side columns separating from the terminal
- the terminal repainting, including any pane you have coloured keeping its colour

Arrow through the five with the keyboard. Close Settings, reopen: the chosen card is still marked. Quit and relaunch: the theme is still applied, from the first frame.

- [ ] **Step 10: Run everything**

Run: `npm test`
Expected: PASS.

Run: `npx playwright test`
Expected: PASS. Watch for specs that count settings tabs or assume the pane opens on Notifications; those assertions are now wrong and need updating to the new first tab rather than being loosened.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/settings/ src/renderer/App.tsx tests/unit/appearanceTabs.test.ts tests/unit/labelContrast.test.ts
git commit -m "Add an Appearance tab with a five-theme picker"
```

---

### Task 8: End-to-end proof that the themes do what they claim

Everything so far asserts values. This asserts the user-visible consequence: that a modal reads as above the page, measured off the rendered document.

**Files:**
- Create: `tests/e2e/colour.ts`
- Create: `tests/e2e/theme.spec.ts`

**Interfaces:**
- Consumes: `THEMES` from Task 1; the `theme-${id}` and `settings-tab-appearance` testids from Task 7.
- Produces: `parseRgb(value: string): string`, `lightnessGap(a: string, b: string): number` for other specs.

- [ ] **Step 1: Write the colour helper**

Create `tests/e2e/colour.ts`:

```ts
/**
 * Computed colours, as hex, plus the lightness distance between two of them.
 *
 * `getComputedStyle` returns `rgb(r, g, b)`, never the hex the stylesheet was
 * written in, so an assertion about a token has to convert before it can
 * compare. Duplicated from `tests/unit/contrast.ts` rather than imported
 * because that module is loaded by the unit suite and this one runs in
 * Playwright, and the two configs do not share a resolver.
 */

/** `rgb(9, 9, 11)` or `rgba(9, 9, 11, 1)` to `#09090b`. Throws on anything else. */
export function parseRgb(value: string): string {
  const found = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value.trim())
  if (!found) throw new Error(`not an rgb colour: ${value}`)
  return `#${found.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function lightness(hex: string): number {
  const y = luminance(hex)
  return y <= 0.008856 ? 903.2963 * y : 116 * Math.cbrt(y) - 16
}

/** Distance in CIE L*, order independent. */
export function lightnessGap(a: string, b: string): number {
  return Math.abs(lightness(a) - lightness(b))
}
```

- [ ] **Step 2: Write the failing spec**

Create `tests/e2e/theme.spec.ts`, following the launch and fixture pattern of an existing spec in `tests/e2e/`:

```ts
import { test, expect } from '@playwright/test'
import { parseRgb, lightnessGap } from './colour'
import { THEMES } from '../../src/shared/themes'

/**
 * What the feature actually claims, measured off the rendered document.
 *
 * Every other test in this feature asserts a value in a table. These assert
 * the consequence: that after choosing a stepped theme, the dialog the user is
 * looking at is a different plane from the panel behind it. A class-name
 * assertion would stay green with the two fills identical, which is the state
 * this whole feature exists to leave behind.
 */

const FILL_FLOOR = 3.0

async function fillOf(locator: import('@playwright/test').Locator): Promise<string> {
  const value = await locator.evaluate((el) => getComputedStyle(el).backgroundColor)
  const hex = parseRgb(value)
  // A missed element gives `rgba(0, 0, 0, 0)`, which converts to #000000 and
  // clears any floor it is compared against. This is the shape of assertion
  // that passes vacuously, so the emptiness is checked before the distance.
  expect(value).not.toContain('rgba(0, 0, 0, 0)')
  return hex
}

test.describe('the theme picker', () => {
  test('lifts a dialog off the page it floats over', async ({ page }) => {
    // Replace with this suite's launch helper.
    await page.keyboard.press('Meta+Comma')
    await expect(page.getByTestId('settings-pane')).toBeVisible()
    await page.getByTestId('settings-tab-appearance').click()

    await page.getByTestId('theme-classic').click()
    const panelUnderClassic = await fillOf(page.getByTestId('files-panel'))
    const dialogUnderClassic = await fillOf(page.getByTestId('settings-pane'))
    // Today's palette, recorded rather than asserted good: the two fills are
    // the same colour, which is the defect the other themes answer.
    expect(lightnessGap(dialogUnderClassic, panelUnderClassic)).toBeLessThan(1)

    await page.getByTestId('theme-stepped').click()
    const panel = await fillOf(page.getByTestId('files-panel'))
    const dialog = await fillOf(page.getByTestId('settings-pane'))
    expect(lightnessGap(dialog, panel)).toBeGreaterThanOrEqual(FILL_FLOOR)
  })

  test('separates the side columns from the terminal', async ({ page }) => {
    await page.keyboard.press('Meta+Comma')
    await page.getByTestId('settings-tab-appearance').click()
    await page.getByTestId('theme-lifted').click()
    await page.keyboard.press('Escape')

    const panel = await fillOf(page.getByTestId('files-panel'))
    const canvas = parseRgb(
      await page
        .locator('.xterm-viewport')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    expect(lightnessGap(panel, canvas)).toBeGreaterThanOrEqual(FILL_FLOOR)
    expect(canvas).toBe(THEMES.lifted.tokens.bg)
  })

  test('survives a relaunch, applied before the first frame', async ({ page }) => {
    // Choose, quit, relaunch with the same config dir, and read the token off
    // documentElement without touching Settings. Follow the relaunch helper
    // this suite already uses for restore specs.
    const applied = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
    )
    expect(applied).toBe(THEMES.slate.tokens.surface)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('slate')
  })
})
```

- [ ] **Step 3: Verify the terminal oracle before trusting it**

The second test reads `.xterm-viewport`'s computed background. That may not reflect xterm's theme.

This repo has already shipped a test asserting against `.xterm-rows`, which the WebGL renderer leaves permanently empty, so the oracle gets checked rather than assumed.

Run: `npx playwright test tests/e2e/theme.spec.ts -g "separates the side columns"`

If it fails because the viewport is transparent or unchanged, the oracle is wrong. Do **not** weaken the assertion. Instead find a hook that does reflect the theme, in this order:

1. `.xterm-screen` or the `.xterm` root's computed background.
2. A test-only read of `term.options.theme` through whatever the suite already uses to reach terminal internals (`__ptermTerminalTexts` is the existing precedent for reaching into a live terminal).

Note in the spec which oracle you settled on and what you observed the others doing.

- [ ] **Step 4: Run the spec and watch it fail for the right reason**

Run: `npx playwright test tests/e2e/theme.spec.ts`

Before the feature is complete this should fail on missing testids. With Tasks 1 through 7 done it should pass. If it passes on the first attempt, confirm it is not passing vacuously by Step 5 before believing it.

- [ ] **Step 5: Prove the spec can fail**

Temporarily change `THEMES.stepped.tokens.overlay` to equal `THEMES.stepped.tokens.surface`.

Run: `npx playwright test tests/e2e/theme.spec.ts -g "lifts a dialog"`
Expected: FAIL on the fill floor.

Revert.

Temporarily change `THEMES.lifted.tokens.bg` to `#1a1a1e`.

Run: `npx playwright test tests/e2e/theme.spec.ts -g "separates the side columns"`
Expected: FAIL.

Revert. If either passed, the test is reading something other than what it claims.

- [ ] **Step 6: Run the whole e2e suite**

Run: `npx playwright test`
Expected: PASS.

A red here reruns `beforeAll` against a fresh app once per failure, so a single real failure can look like several. Read the first one.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/colour.ts tests/e2e/theme.spec.ts
git commit -m "Measure the elevation claim end to end"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: token model → Tasks 2 and 3; TS registry → Task 1; config and version 9 → Task 4; pre-paint and the `env` bridge → Task 5; the four palettes → Task 1 (values) applied by Task 5; terminal and pane colours → Task 6; settings UI → Task 7; testing → distributed, with the e2e claims in Task 8.

**Two corrections to the spec, found while reading the code:**

1. The spec lists `IssuesPanel.tsx` as a selected-row repoint site. It is not: `IssuesPanel` marks selection with `text-fg` alone and has no `bg-bg`. Task 3 does not touch it.
2. The spec does not mention that `CommandPalette.tsx` and `SettingsPane.tsx` inherit their fill from `DialogContent`. They need no edit of their own, which makes Task 3 smaller than the spec implies.

**One decision the code made for us.** The spec left open whether `muted` should be held to AA in every theme. `FileTree.tsx:384-389` already measures Classic's `muted` at 4.044:1 and accepts it, explicitly on the grounds that "this background is fixed chrome the user cannot recolour". This feature falsifies that premise. Task 1 therefore demands 4.5 of every new theme (all four clear it) and pins Classic's exemption to its measured value. The comment in `FileTree.tsx` is now stale and should be re-derived when someone next touches that file.

**Open question carried from the spec, still open.** Lifted chrome's canvas is `#060607`, darker than `PANE_COLORS[0]` (`#09090b`). Under that theme the pane-colour picker's "put it back" swatch and its darkest offered colour are no longer the same value. Task 6 keeps the shared ramp, which is correct and loses no user data, but the picker's first swatch rendering the live canvas is not covered by any task here. It is cosmetic and confined to one control. Decide it when the picker is next opened under Lifted chrome.

**Type consistency.** `ThemeId`, `ThemeTokens`, `Theme`, `Separation`, `THEMES`, `THEME_IDS`, `THEME_DEFAULT`, `isThemeId`, `cssVarName` are defined in Task 1 and used with those exact names in Tasks 2 through 8. `themeProperties`, `applyTheme` and `bootTheme` are defined in Task 5 and used in Tasks 5, 6 and 7. `xtermTheme` is defined in Task 6 and used only there. `parseRgb` and `lightnessGap` are defined in Task 8 for `tests/e2e/`, and `lightness`/`lightnessGap` separately in Task 1 for `tests/unit/`; the duplication is deliberate and noted in both files.

**Placeholder scan.** No TBDs. Every code step carries the code. Task 6 Step 5 and Task 8 Step 2 are the two places that say "follow the pattern this suite already uses" rather than quoting it, because the surrounding component's prop threading and the e2e launch fixture are local details the implementer will have in front of them and this plan should not guess at.
