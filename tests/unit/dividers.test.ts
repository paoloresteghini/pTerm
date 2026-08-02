import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * The drag gesture, checked against source text because nothing in this suite
 * can press a mouse button.
 *
 * `vitest.config.mts` runs in `environment: 'node'`: there is no DOM to render
 * `PaneDivider` into, and a DOM alone would not be enough — jsdom performs no
 * layout, so `offsetWidth` and a percentage `left` would both report nothing
 * about the thing at stake. The arithmetic a drag runs *once it has its inputs*
 * is unit-tested properly, in `resizeKids` and `minRatioFor` (workspace.test.ts)
 * — though not the arithmetic in `App.tsx` that decides what to hand them, which
 * is declared below rather than covered. What is left over is *that the gesture
 * is wired to it*, *that the strip takes no space in the layout it exists to
 * adjust*, and *that the box the divider is positioned against is the box the
 * panes are laid out in*.
 *
 * **What this does NOT cover, stated so it is not mistaken for coverage:**
 *
 * - that a pointerdown starts a drag at all, or that a pointerup ends one;
 * - that the cursor changes, or that a 7px strip is comfortable to hit;
 * - that React actually calls the effect's cleanup — the assertion below reads
 *   the text `window.removeEventListener`, nothing more;
 * - that a pane follows the cursor 1:1 over a long drag, that it stops at the
 *   floor, or that the tmux session reflows behind it;
 * - **`grabPane`'s refusal guards** — the length check and the two identity
 *   checks that stop a box index being taken for a kid index. That is the
 *   subtlest logic in this whole change and nothing anywhere executes it:
 *   measured, deleting all three leaves this file nine of nine green. It is not
 *   pinned by a text assertion either, deliberately — one would catch a deletion
 *   while saying nothing about the far likelier regression, a guard that is
 *   present and wrong, and would leave this bullet reading like coverage;
 * - **the floor derivation** — `axisCells = grid.cols / low.share`, and the
 *   `minRatioFor` call it feeds. New arithmetic, living in `App.tsx`, with no
 *   unit test here or in workspace.test.ts. The `minRatioFor(` assertion below
 *   is a bare token and was measured to be one: swapping its two arguments
 *   passes, and so does turning that `/` into a `*`. The way to close this is to
 *   move the derivation into `workspace.ts` and test it as a function, not to
 *   add a cleverer grep;
 * - **where the divider lands.** `offset` is a cumulative sum computed in
 *   `App.tsx` and turned into a percentage at runtime. A wrong sum draws the
 *   strip over the wrong seam — or at the tab's leading edge — and every
 *   assertion in this file still passes. That was measured, not assumed: see
 *   the list below.
 *
 * A human with the app open is the only thing that sees any of those. Same
 * trade as `appLayout.test.ts`, and the same reason.
 *
 * **Edits that will fail this without anything being wrong.** Each was made
 * against the real files and the result counted, so this list is measured
 * rather than inferred:
 *
 * - renaming `group` in App.tsx — 3: both assertions anchored on the overlay,
 *   and the placement one, which names `group.panes.map`.
 * - renaming the `dividers-` testid — 2, that same overlay anchor.
 * - renaming `index` in the divider map — 1. Renaming `held` or `grabbed` in
 *   the drag path — 1, the same one, for either.
 * - moving this JSX into its own component file — every App assertion. This
 *   test reads `App.tsx` by path; it follows the code nowhere.
 *
 * And, in the other direction, two edits measured NOT to fail it — the more
 * useful half of the list, because each changes what a user sees. Replacing
 * `slice(0, index)` in the `offset` sum with `slice(0, index - 1)`: every
 * divider drawn one seam early, the first of them flush against the tab's
 * leading edge. And replacing the `${offset * 100}%` the strip is placed at
 * with a constant `0%`: every divider in the app stacked at that same leading
 * edge. Nine of nine green both times. If you are changing either, the running
 * app is the only thing that will tell you.
 *
 * Worth knowing about one that *does* fail, because it fails for the wrong
 * reason: changing the render gate from `index > 0` to `index >= 0` — which
 * draws exactly the leading-edge divider the two edits above draw — is caught,
 * but only because `>=` is different TEXT from `>`. Nothing here can see the
 * strip that appears. Do not read that failure as coverage of placement.
 */

/**
 * Comments out, then whitespace flattened — the same reader `appLayout.test.ts`
 * uses, for the same two reasons. Comments out so that a comment which merely
 * *mentions* one of these strings can neither satisfy nor fail an assertion
 * about the code; whitespace flattened so that reindenting, rewrapping and
 * moving attributes onto one line all read the same.
 */
function readCode(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

const app = readCode('../../src/renderer/App.tsx')
const divider = readCode('../../src/renderer/PaneDivider.tsx')

describe('the divider takes no space in the layout', () => {
  it('is absolutely positioned, and is not a flex item', () => {
    // A divider in the flow would widen the flex container's content and change
    // the very ratios it exists to adjust: the panes' `flexBasis` values sum to
    // the whole container, and the one-pixel `gap-px` overflow is already
    // budgeted against them.
    expect(divider).toMatch(/absolute/)
    expect(divider).not.toMatch(/flex-(1|auto|initial)/)
  })

  it('lets clicks through everywhere except the strip itself', () => {
    // The overlay spans the whole tab. Without this it would swallow every
    // mousedown meant for a pane — which is what selects a pane and what starts
    // a text selection inside one.
    const overlay = /data-testid=\{`dividers-\$\{group\.id\}`\} className="([^"]*)"/.exec(app)
    expect(overlay).not.toBeNull()
    expect((overlay?.[1] ?? '').split(' ')).toContain('pointer-events-none')
    expect(divider).toMatch(/pointer-events-auto/)
  })

  it('offers a resize cursor on both axes', () => {
    expect(divider).toMatch(/col-resize/)
    expect(divider).toMatch(/row-resize/)
  })
})

describe('the box the divider is measured and positioned against', () => {
  it('is the group container’s content box, not its padding box', () => {
    // The one property of the placement that source text CAN see, and the one
    // that was wrong first time. An absolutely positioned child resolves its
    // percentages against its containing block's PADDING box, while the panes
    // lay out in the CONTENT box. With the dividers as direct children of the
    // padded group container, `left: 50%` missed the real seam by up to the
    // padding (zero error at the middle, worst at the ends) and
    // `parentElement.offsetWidth` overstated the drag axis by twice it, so
    // every drag ran slow and the strip crept away from the cursor.
    //
    // The overlay exists to make both resolve against the right box, which it
    // does only for as long as its inset equals the container's padding. That
    // duplication is the point of this assertion: the two numbers are one fact
    // written twice, and nothing else would notice them drifting apart.
    const statics = /key=\{ ?group\.id ?\}.*?className=\{cn\( ?'([^']*)'/.exec(app)
    expect(statics).not.toBeNull()
    const padding = /(?:^| )p-(\d+)(?: |$)/.exec(statics?.[1] ?? '')
    expect(padding).not.toBeNull()

    const overlay = /data-testid=\{`dividers-\$\{group\.id\}`\} className="([^"]*)"/.exec(app)
    expect(overlay).not.toBeNull()
    const classes = (overlay?.[1] ?? '').split(' ')
    expect(classes).toContain('absolute')
    expect(classes).toContain(`inset-${padding?.[1] ?? ''}`)
  })
})

describe('the gesture reaches the arithmetic', () => {
  it('converts pixels to a ratio against the container it is in', () => {
    // px -> ratio is the only conversion the divider owns; taking the span from
    // anything other than the box the panes divide makes every drag the wrong
    // distance.
    expect(divider).toMatch(/offsetWidth|getBoundingClientRect/)
  })

  it('listens on the window, not on itself, and takes back every listener it adds', () => {
    // A pointer that leaves the 7px strip mid-drag must not end the drag, and a
    // release outside the window must still end it.
    expect(divider).toMatch(/window\.addEventListener\( ?'(pointermove|mousemove)'/)

    // Name against name, not a bare mention of `removeEventListener`. Measured:
    // with the presence check alone, deleting the `pointermove` teardown while
    // leaving the other two passed — one leaked listener per divider per render,
    // each still holding the previous render's closure, and the assertion that
    // was supposed to be watching for exactly that said nothing.
    const listeners = (verb: string): string[] =>
      [...divider.matchAll(new RegExp(`window\\.${verb}EventListener\\( ?'([a-z]+)'`, 'g'))].map(
        (match) => match[1] ?? '',
      )
    const added = listeners('add')
    expect(added).not.toHaveLength(0)
    expect(listeners('remove').sort()).toEqual([...added].sort())
  })

  it('App clamps through resizeKids and dispatches resized', () => {
    expect(app).toMatch(/resizeKids\(/)
    expect(app).toMatch(/minRatioFor\(/)
    expect(app).toMatch(/type: 'resized'/)
  })

  it('applies the movement to the ratio captured at pointerdown, not the live one', () => {
    // The divider reports the CUMULATIVE travel since pointerdown — that is what
    // makes a clamped drag behave: push into the floor, keep pushing, reverse,
    // and the divider stays pinned until the cursor comes back past the point
    // where the floor bit. Applying that cumulative number to the live ratio,
    // which the previous frame already moved, re-adds the whole travel every
    // frame: 0.50 -> 0.51 -> 0.53 -> 0.56 for three even steps of 0.01. It is
    // quadratic in frame count and pins to the floor within a few frames.
    expect(app).toMatch(/grabbed\.current/)
    expect(app).toMatch(/resizeKids\( ?held\.ratio ?,/)
    expect(app).not.toMatch(/resizeKids\( ?row\.layout\.ratio/)
  })

  it('renders one divider between each adjacent pair, and none at either edge', () => {
    // `index > 0`, over `group.panes` itself: the last index is `length - 1`, so
    // gating on the leading edge is the whole rule — a divider at either end of
    // the tab would have nothing on one side of it, and `resizeKids` answers a
    // pair with a missing half by returning the ratio untouched.
    expect(app).toMatch(/<PaneDivider/)
    expect(app).toMatch(/group\.panes\.map\(\(box, index\)/)
    expect(app).toMatch(/index > 0 \?[( ]*<PaneDivider/)
  })
})
