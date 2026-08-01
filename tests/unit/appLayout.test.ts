import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * Three properties of the terminal area that no test in this suite can observe
 * at runtime, checked against the source text instead.
 *
 * `vitest.config.mts` runs in `environment: 'node'`: there is no DOM to render
 * `App.tsx` into, and a DOM alone would not be enough anyway — jsdom performs
 * no layout, so `offsetParent`, `clientWidth` and `getBoundingClientRect`
 * would report nothing about the very thing at stake. The arithmetic that
 * decides the arrangement is unit-tested properly, in `paneGroups`
 * (workspace.test.ts). What is left over is *that App.tsx renders all of it*,
 * *that it hides a tab with `visibility`*, and *that Terminal.tsx checks its
 * container before fitting to it* — the three properties whose loss drives a
 * real tmux session to a nonsense size. A grep is a poor test; it is better
 * than the nothing that is otherwise on offer here.
 */

/**
 * Comments out, then whitespace flattened.
 *
 * Comments out because a class list sits behind one, and because a comment
 * that merely *mentions* one of these strings must not be able to satisfy — or
 * to fail — an assertion about the code. No string literal in either file
 * contains `//`, so nothing else goes with them. Whitespace flattened so that
 * reindenting, rewrapping, brace padding and moving attributes onto one line
 * all read the same.
 */
function readCode(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

const app = readCode('../../src/renderer/App.tsx')
const terminal = readCode('../../src/renderer/Terminal.tsx')

describe('App.tsx terminal area', () => {
  it('mounts every group and every pane in it, filtering neither', () => {
    // Adjacent `.map(`, so inserting a `.filter(...)` for the current tab —
    // the change that would unmount a hidden tab's xterm and take its
    // scrollback with it — breaks both of these.
    expect(app).toMatch(/\{ ?paneGroups\(state\)\.map\(/)
    expect(app).toMatch(/\{ ?group\.panes\.map\(/)
  })

  it('mounts its one Terminal unconditionally', () => {
    expect(app.match(/<Terminal\b/g)).toHaveLength(1)
    // A guard immediately in front of it is the other way to unmount one.
    expect(app).not.toMatch(/(\?|&&|:) ?<Terminal\b/)
  })

  it('hides a tab with visibility, never with display', () => {
    const ternary = /group\.visible \? '([^']*)' : '([^']*)'/.exec(app)
    expect(ternary).not.toBeNull()
    const shown = (ternary?.[1] ?? '').split(' ')
    const hidden = (ternary?.[2] ?? '').split(' ')
    expect(shown).toContain('visible')
    expect(hidden).toContain('invisible')
    // Tailwind's `hidden` is `display: none`. A container with that measures
    // 0x0 — and while FitAddon happens to bail on that one (a `display: none`
    // parent computes `width: auto`, which parses to NaN), an inline
    // `display: none` is the same intent and there is no reason to allow it.
    expect(shown).not.toContain('hidden')
    expect(hidden).not.toContain('hidden')
    expect(app).not.toMatch(/display:\s*['"]?none/)
  })

  it('is a flex container that fills the pane area, and applies the computed styles', () => {
    // Anchored on the container's own `key`, so this cannot drift onto some
    // other `cn(` call added earlier in the file later on.
    const statics = /key=\{ ?group\.id ?\}.*?className=\{cn\( ?'([^']*)'/.exec(app)
    expect(statics).not.toBeNull()
    const classes = (statics?.[1] ?? '').split(' ')
    expect(classes).toContain('flex')
    expect(classes).toContain('absolute')
    expect(classes).toContain('inset-0')
    expect(classes).not.toContain('hidden')
    // The axis and the shares come from `paneGroups`, which is where they are
    // tested. If they stop being applied here, that test is measuring
    // something nothing renders.
    expect(app).toMatch(/style=\{ ?group\.style ?\}/)
    expect(app).toMatch(/style=\{ ?box\.style ?\}/)
  })
})

describe('Terminal.tsx fitToContainer', () => {
  /**
   * Both guards, and both *above* the fit.
   *
   * Ordering rather than presence, because the realistic regression is
   * someone consolidating two guards and leaving one below the call — which
   * keeps every string in the file and would sail past a presence check. The
   * two are not redundant: they diverge inside FitAddon. A `display: none`
   * parent computes `width: auto`, `parseInt` gives NaN, and `fit()` takes its
   * own early return — that is the case `offsetParent` covers. A laid-out box
   * of zero size computes `width: 0px`, which parses fine and floors to
   * `Math.max(2, 0)` by `Math.max(1, 0)`: 2x1, sent straight to the real tmux
   * session. Only the second guard sees that one.
   */
  it('checks the container is laid out and has a box before fitting to it', () => {
    const laidOut = terminal.indexOf('container.offsetParent === null')
    const hasBox = terminal.search(/container\.clientWidth === 0/)
    const fit = terminal.indexOf('fit.fit()')
    expect(laidOut).toBeGreaterThan(-1)
    expect(hasBox).toBeGreaterThan(-1)
    expect(fit).toBeGreaterThan(-1)
    expect(terminal).toMatch(/container\.clientHeight === 0/)
    expect(laidOut).toBeLessThan(fit)
    expect(hasBox).toBeLessThan(fit)
  })
})
