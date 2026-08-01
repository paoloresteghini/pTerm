import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * Two properties of the terminal area that no test in this suite can observe
 * at runtime, checked against the source text instead.
 *
 * `vitest.config.mts` runs in `environment: 'node'`: there is no DOM to render
 * `App.tsx` into, and a DOM alone would not be enough anyway — jsdom performs
 * no layout, so `offsetParent` and `getBoundingClientRect` would report
 * nothing about the very thing at stake. The arithmetic that decides the
 * arrangement is unit-tested properly, in `paneGroups` (workspace.test.ts).
 * What is left over is *that App.tsx renders all of it, and hides a tab with
 * `visibility`* — and both of those are exactly the properties whose loss
 * drives a real tmux session to a nonsense size. A grep is a poor test; it is
 * better than the nothing that is otherwise on offer here.
 *
 * Whitespace is flattened first, so reindenting, rewrapping or moving these
 * attributes onto one line cannot fail this. Renaming `group`/`box`, changing
 * the quote style, or splitting the JSX into another component will fail it,
 * and should: at that point someone has to come back and re-establish the
 * invariant here by hand.
 */
const source = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8')
/**
 * Comments out, then whitespace flattened. Out because the class list sits
 * behind one, and because a comment that merely *mentions* one of these
 * strings must not be able to satisfy an assertion about the code. No string
 * literal in this file contains `//`, so nothing else goes with them.
 */
const flat = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')

describe('App.tsx terminal area', () => {
  it('mounts every group and every pane in it, filtering neither', () => {
    // Adjacent `.map(`, so inserting a `.filter(...)` for the current tab —
    // the change that would unmount a hidden tab's xterm and take its
    // scrollback with it — breaks both of these.
    expect(flat).toMatch(/\{ ?paneGroups\(state\)\.map\(/)
    expect(flat).toMatch(/\{ ?group\.panes\.map\(/)
  })

  it('mounts its one Terminal unconditionally', () => {
    expect(flat.match(/<Terminal\b/g)).toHaveLength(1)
    // A guard immediately in front of it is the other way to unmount one.
    expect(flat).not.toMatch(/(\?|&&|:) ?<Terminal\b/)
  })

  it('hides a tab with visibility, never with display', () => {
    const ternary = /group\.visible \? '([^']*)' : '([^']*)'/.exec(flat)
    expect(ternary).not.toBeNull()
    const shown = (ternary?.[1] ?? '').split(' ')
    const hidden = (ternary?.[2] ?? '').split(' ')
    expect(shown).toContain('visible')
    expect(hidden).toContain('invisible')
    // Tailwind's `hidden` is `display: none`. A container with that measures
    // 0x0, and the fit that follows would resize the real tmux session to
    // FitAddon's floor of 2x1.
    expect(shown).not.toContain('hidden')
    expect(hidden).not.toContain('hidden')
    expect(source).not.toMatch(/display:\s*['"]?none/)
  })

  it('is a flex container that fills the pane area, and applies the computed styles', () => {
    const statics = /className=\{cn\( ?'([^']*)'/.exec(flat)
    expect(statics).not.toBeNull()
    const classes = (statics?.[1] ?? '').split(' ')
    expect(classes).toContain('flex')
    expect(classes).toContain('absolute')
    expect(classes).toContain('inset-0')
    expect(classes).not.toContain('hidden')
    // The axis and the shares come from `paneGroups`, which is where they are
    // tested. If they stop being applied here, that test is measuring
    // something nothing renders.
    expect(flat).toContain('style={group.style}')
    expect(flat).toContain('style={box.style}')
  })
})
