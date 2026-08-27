import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * Four properties of the terminal area that no test in this suite can observe
 * at runtime, checked against the source text instead.
 *
 * `vitest.config.mts` runs in `environment: 'node'`: there is no DOM to render
 * `App.tsx` into, and a DOM alone would not be enough anyway — jsdom performs
 * no layout, so `offsetParent`, `clientWidth` and `getBoundingClientRect`
 * would report nothing about the very thing at stake. The arithmetic that
 * decides the arrangement is unit-tested properly, in `paneGroups`
 * (workspace.test.ts). What is left over is *that App.tsx renders all of it*,
 * *that it hides a tab with `visibility`*, *that Terminal.tsx checks its
 * container before fitting to it*, and *that a dead pane's chrome overlays its
 * box rather than taking room in it* — the four properties whose loss drives a
 * real tmux session, or a still-mounted xterm, to a nonsense size. A grep is a
 * poor test; it is better than the nothing that is otherwise on offer here.
 *
 * **Edits that will fail this without anything being wrong.** Each was made
 * against the real files and the result counted, so this list is measured
 * rather than inferred:
 *
 * - renaming `group` in App.tsx — 3 of the 4 App assertions; renaming `box` —
 *   3 (the computed styles, and both assertions that read the pane box: the
 *   dead gate and the box's own class list).
 * - switching the class strings to double quotes — 2 (the visibility ternary
 *   and the class list). The two `.map(` assertions do not read quotes.
 * - moving this JSX into its own component file — all 4. This test reads
 *   `App.tsx` by path; it follows the code nowhere.
 * - renaming `container` in Terminal.tsx — the guard assertion.
 * - renaming `restartTab` in App.tsx, or renaming either the `pane-restart-` or
 *   the `pane-dismiss-` testid — 1 each, the wiring assertion. It finds each
 *   button by its own testid and names the handler each must reach, because
 *   what it says is that *this* glyph reaches *that* handler, and there is no
 *   way to say that without naming both ends.
 * - renaming `pane` in DeadPane.tsx — 2: the wiring assertion, and the overlay
 *   assertion, which anchors on `` data-testid={`dead-${pane.id}`} ``.
 * - renaming the `dead-` testid — 1, that same anchor.
 * - reordering the strip's own attributes so its `className` comes before its
 *   `data-testid` — 1, that anchor again: it then walks forward to the FIRST
 *   button's class list instead (measured: it captures
 *   `pointer-events-auto cursor-default ...`). Loud, but worth knowing, since
 *   "moving attributes onto one line" is tolerated below and a reader could
 *   reasonably extend that to moving them past each other.
 * - moving DeadPane's strip classes into a `cn(` call — 1, the overlay
 *   assertion, which reads a `className="..."` literal.
 *
 * Which leaves one of DeadPane.tsx's three testids free: the dot's. The other
 * two are named by an assertion and are not yours to rename quietly.
 *
 * If you are here because of one of those, the invariant is not broken and the
 * fix is to re-point the assertion at the new name or the new file — but do
 * re-point it, because nothing else in this suite is watching these
 * properties. Everything else was measured too, in the other direction:
 * reindenting, rewrapping, brace padding, reordering or adding classes,
 * changing a `data-testid` **no assertion names** — which was all of them until
 * the dead-pane block below, and is now all but the three named above —
 * adding a `cn(` call earlier in the file, and
 * editing any comment — including one that contains the words `display: none`,
 * and one that quotes `state.dead[` or `box.dead` in prose — all leave it
 * green. So do the edits the dead-pane block was written not to care about:
 * swapping which of ↻ and × is drawn first, changing either glyph, renaming
 * the dot's testid, and wrapping the `<DeadPane>` render in a fragment.
 *
 * The overlay assertion's anchor is the one place that trade was made the other
 * way, and deliberately: unanchored, it read the first `className="` in the
 * file, and an element added above the strip carrying `absolute` and
 * `pointer-events-none` satisfied it while describing the wrong element —
 * measured, and silent. Two names for one anchor is the price of that not
 * happening.
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
const deadPane = readCode('../../src/renderer/DeadPane.tsx')

describe('App.tsx terminal area', () => {
  it('mounts every group and every pane in it, filtering neither', () => {
    // Adjacent `.map(`, so inserting a `.filter(...)` for the current tab —
    // the change that would unmount a hidden tab's xterm and take its
    // scrollback with it — breaks both of these.
    expect(app).toMatch(/\{ ?groups\.map\(/)
    expect(app).toMatch(/\{ ?group\.panes\.map\(/)
    // `groups` is hoisted above the JSX, so the filter this test is named for
    // could just as easily land on its assignment as on the `.map(` that reads
    // it. A bare `paneGroups\(state\) ` anchor caught a same-line splice
    // (`paneGroups(state).filter(...)` leaves no space before `.filter(` for
    // it to find) but missed one wrapped onto its own line, where `readCode`'s
    // flattened newline supplies exactly the space that anchor wanted.
    // Requiring `const showWelcome` immediately after closes the wrapped case
    // too.
    //
    // Re-pointed 2026-08-17, when wall mode gave the call its region and its
    // wall: the anchor names the whole call because what it is guarding is the
    // gap AFTER it, and a bare `paneGroups\(` prefix would let a `.filter(`
    // sit inside the argument list. `wallView` is named for the same reason
    // `group` is named above: this is a text assertion, and renaming it here
    // is the price of it being able to say anything at all.
    expect(app).toMatch(/const groups = paneGroups\(state, 'terminal', wallView\) const showWelcome\b/)
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
    expect(classes).not.toContain('hidden')
    // `inset-0` left the static string in wall mode and became conditional on
    // the group having no rect, so this is now two claims rather than one.
    // Both are the same property: a group fills the pane area unless the wall
    // gave it a cell to fill instead, and a group WITHOUT a cell (which every
    // hidden group is, wall or no wall) still fills the whole column. A hidden
    // group that shrank to a cell would be measured at that size by the next
    // fit that reached it, which is the tmux-resize hazard this file exists for.
    expect(classes).not.toContain('inset-0')
    expect(app).toMatch(/group\.rect \? '' : 'inset-0'/)
    // The axis and the shares come from `paneGroups`, which is where they are
    // tested. If they stop being applied here, that test is measuring
    // something nothing renders. Spread into an object literal rather than
    // passed alone for the reason `box.style` is below: the wall's rect rides
    // in the same `style` prop, and the axis has to survive that.
    expect(app).toMatch(/style=\{\{ ?\.\.\.group\.style,/)
    // And the rect itself reaches the box. It is the whole of where a cell is;
    // without it every group would stack at the same place.
    expect(app).toMatch(/\.\.\.group\.rect ?\}\}/)
    // `box.style` spread into an object literal rather than passed alone: the
    // pane's background rides in the same `style` prop, and the flex basis it
    // carries has to survive that. A regex naming only `box.style` would have
    // gone red on the colour change even though the layout claim still holds.
    expect(app).toMatch(/style=\{\{ ?\.\.\.box\.style,/)
  })
})

/**
 * Each `tag` element in `source`, from the tag to its own closing one.
 *
 * The closing tag is what bounds them: splitting on the opening tag alone would
 * run the last element to the end of the file and let anything added after it
 * answer for that element.
 */
function elements(source: string, tag: string): string[] {
  const close = `</${tag.slice(1)}>`
  return source
    .split(tag)
    .slice(1)
    .map((rest) => {
      const end = rest.indexOf(close)
      // Never `slice(0, end)` with `end` unchecked. `indexOf` answers -1 for an
      // element with no closing tag — a self-closing one, or an unclosed one —
      // and `slice(0, -1)` reads that as "everything to the end bar one
      // character", which is the over-capture this bounding exists to prevent,
      // reintroduced in the one case it was written for.
      //
      // Sometimes that is quiet rather than loud: measured, a `<button ... />`
      // with no closing tag passed the `pointer-events-auto` loop below after
      // losing that very class, by over-capturing text that still carried it.
      // Which arrangements are quiet and which are loud is not written down
      // here on purpose — two attempts at that enumeration were wrong, and the
      // throw needs a reason, not a proof. An element this cannot bound is one
      // it must not describe; the test below pins that, where it cannot rot.
      if (end === -1) throw new Error(`No ${close} for an opening ${tag}`)
      return rest.slice(0, end)
    })
}

describe('the elements() helper the dead-pane assertions read through', () => {
  it('bounds each element at its own closing tag, and refuses one that has none', () => {
    const two = '<button a>one</button> between <button b>two</button> after'
    expect(elements(two, '<button')).toEqual([' a>one', ' b>two'])
    // The case worth a test of its own, because it is the one that fails
    // quietly. `indexOf` answers -1 for an element with no closing tag, and
    // `slice(0, -1)` reads that as "to the end bar one character" — the whole
    // rest of the file, which is exactly the over-capture the bounding exists
    // to prevent. It still contains every string a caller greps for, so the
    // assertion reading it goes on passing while describing something else.
    expect(() => elements('<button a>one', '<button')).toThrow(/<\/button>/)
  })
})

describe('the chrome over a dead pane', () => {
  /**
   * What a dead pane offers, and where the offer comes from.
   *
   * Whether a pane is dead, whether it keeps its box and what share that box
   * takes are all decided in `paneGroups` and tested there. What is left over
   * is that App.tsx renders the offer at all, that the two glyphs are wired to
   * different actions, and that the strip takes no room in the pane — the last
   * being the one that would refit the still-mounted xterm and reflow the
   * scrollback the whole affordance exists to keep readable.
   */
  it('renders it for a box the layout marked dead, and decides deadness nowhere else', () => {
    expect(app).toMatch(/<DeadPane\b/)
    expect(app).toMatch(/\{ ?box\.dead \?/)
    // A second reading of `state.dead` beside the render is a second rule to
    // keep in step with `paneGroups`, and only one of the two has a test.
    expect(app).not.toMatch(/state\.dead\[/)
  })

  it('hands the restart the pane and the dismiss its id, and not the other way round', () => {
    // The M3 hazard, one level down: a dead tab's × is Dismiss while a live
    // one's is Close, and the ↻ beside it is a third wiring behind a fourth
    // glyph. Swapping two of them type-checks — `onRestart(pane)` and
    // `onDismiss(pane.id)` differ only in what they are handed — and shows up
    // as a click that kills the session it was asked to bring back.
    // One element at a time, found by its own testid rather than by position,
    // so swapping which glyph is drawn first reads the same — that is a
    // presentation choice, and pinning it here would cost a spurious failure
    // for nothing.
    const buttons = elements(deadPane, '<button')
    expect(buttons).not.toHaveLength(0)
    const restart = buttons.find((button) => button.includes('pane-restart-'))
    const dismiss = buttons.find((button) => button.includes('pane-dismiss-'))
    expect(restart).toBeDefined()
    expect(dismiss).toBeDefined()
    expect(restart).toMatch(/onRestart\(pane\)/)
    expect(restart).not.toMatch(/onDismiss\(/)
    expect(dismiss).toMatch(/onDismiss\(pane\.id\)/)
    expect(dismiss).not.toMatch(/onRestart\(/)
    // And that App gives those two props the handlers that reach main. The
    // restart deliberately names no tab: main owns `paneId → tabId` and a tab
    // id sent from here is one that can be wrong.
    expect(app).toMatch(/onRestart=\{restartTab\}/)
    expect(app).toMatch(/onDismiss=\{dismissTab\}/)
  })

  it('overlays the pane rather than taking room in it', () => {
    // Anchored on the pane box's own `key`, so this reads that box's classes
    // and not the group container's, which is asserted separately above.
    const box = /key=\{ ?box\.pane\.id ?\}.*?className=\{cn\( ?'([^']*)'/.exec(app)
    expect(box).not.toBeNull()
    // Without a positioned box the strip resolves against whatever ancestor is
    // positioned and lands over a pane that did not die.
    expect((box?.[1] ?? '').split(' ')).toContain('relative')

    // Anchored on the strip's own testid, for the reason the two assertions
    // above are anchored on a `key`: unanchored, this takes the first
    // `className="` in the file, and an element added above the strip carrying
    // both of these classes would satisfy it while describing the wrong thing.
    // The strip's is first today, which is exactly how long that holds.
    const strip = /data-testid=\{`dead-\$\{pane\.id\}`\}.*?className="([^"]*)"/.exec(deadPane)
    expect(strip).not.toBeNull()
    const classes = (strip?.[1] ?? '').split(' ')
    // A strip in the flow would shrink the box, `Terminal` would fit itself to
    // the smaller container, and tmux is not what reflows the scrollback here —
    // the xterm is, and it is still mounted over a dead session.
    expect(classes).toContain('absolute')
    expect(classes).toContain('pointer-events-none')

    // Which leaves the buttons to opt back in one at a time, so the scrollback
    // stays selectable everywhere the glyphs are not.
    const buttons = elements(deadPane, '<button')
    expect(buttons).not.toHaveLength(0)
    for (const button of buttons) expect(button).toMatch(/pointer-events-auto/)
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

  it('redraws after a fit whose pixel size changes without changing its grid', () => {
    // FitAddon clears and redraws only when its proposed row or column count
    // changes. Wall cells can move by pixels while retaining the same grid,
    // so this redraw is what prevents a stale WebGL frame from remaining on
    // screen until the user resizes the window.
    expect(terminal).toMatch(/const grid = \{ cols: term\.cols, rows: term\.rows \} fit\.fit\(\) if \(term\.cols === grid\.cols && term\.rows === grid\.rows\) \{ term\.refresh\(0, term\.rows - 1\) \}/)
  })
})
