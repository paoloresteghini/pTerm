import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * The drag gesture, checked against source text because nothing in THIS FILE
 * can press a mouse button.
 *
 * Something in the repo now can. `tests/e2e/splits.spec.ts` drives a real
 * pointer onto a real divider in a real window, and three of the items this
 * header used to list as unseeable are seen there. The list below marks which,
 * and marks the two that are still nobody's — the distinction matters, because
 * a reader who takes this file's word for what cannot be tested will read a red
 * `splits.spec.ts` as noise.
 *
 * `vitest.config.mts` runs in `environment: 'node'`: there is no DOM to render
 * `PaneDivider` into, and a DOM alone would not be enough — jsdom performs no
 * layout, so `offsetWidth` and a percentage `left` would both report nothing
 * about the thing at stake. The arithmetic a drag runs *once it has its inputs*
 * is unit-tested properly, in `resizeKids` and `minRatioFor` (workspace.test.ts)
 * — though not the arithmetic in `App.tsx` that decides what to hand them, which
 * is declared below rather than covered. What is left over is *that the gesture
 * is wired to it*, *that the strip takes no space in the layout it exists to
 * adjust*, *that the box the divider is positioned against is the box the
 * panes are laid out in*, and, since the "a drag is written to disk once it
 * ends" describe below was added, *that the gesture's end reaches
 * `window.prcli.setLayout` at all* — deleting that call, or unwiring
 * `PaneDivider`'s `onCommit`, used to leave the whole suite (508 unit, 255
 * integration, at the time this was measured) green; now each fails exactly
 * one assertion in this file, and only that one.
 *
 * **What this does NOT cover, stated so it is not mistaken for coverage:**
 *
 * - **that main actually persists what this handler sends.** This file only
 *   reaches as far as the IPC call being made — `window.prcli.setLayout(...)`
 *   — and never what main does with it once it arrives; that is not this
 *   file's ground to cover and never was. What main does with it is now
 *   pinned elsewhere: `layoutWrite` and `routeShares` in `shares.test.ts`
 *   cover the routing decision, and `persistence.test.ts` covers the write
 *   reaching disk, tombstone and all;
 * - **that a pointerdown starts a drag at all, or that a pointerup ends one —
 *   covered since this branch**, by `tests/e2e/splits.spec.ts`'s `dragging the
 *   divider moves the seam, reflows tmux, and is written down on release`. It
 *   reads the pane widening BETWEEN the press and the release, so the press
 *   started something, and then waits for the row to reach disk, which only
 *   `onCommit` on the release sends;
 * - that the cursor changes, or that a 7px strip is comfortable to hit. **Still
 *   nobody's.** `splits.spec.ts` never reads a computed `cursor` and says so in
 *   its own non-coverage header; a human with the app open remains the only
 *   thing that sees it;
 * - that React actually calls the effect's cleanup — the assertion below reads
 *   the text `window.removeEventListener`, nothing more. **Still nobody's**,
 *   with a caveat worth stating rather than glossing: `splits.spec.ts` runs the
 *   real component in a real DOM, so the cleanup does EXECUTE there, but no
 *   assertion in that file is aimed at a leaked listener and no mutation has
 *   been run to see whether one would fail. Executing a path is not covering it;
 * - **that a pane follows the cursor 1:1 over a long drag, that it stops at the
 *   floor, or that the tmux session reflows behind it — all three covered since
 *   this branch**, by the same file: three equal cursor steps read mid-gesture
 *   producing three equal width gains (0.008px of spread, measured), then `a
 *   drag stops at the floor, and the same gesture reversed reopens the pane`,
 *   then a poll on tmux's own `#{window_width}` after the release;
 * - **`grabPane`'s refusal guards were here** — the length check and the two
 *   identity checks that stop a box index being taken for a kid index. This
 *   file could not see them: measured, deleting all three left it eleven of
 *   eleven green. Eleven and not the twelve below because that measurement was
 *   taken while this file still held eleven tests and the guards still lived in
 *   `App.tsx`; it cannot be re-run against either as they now stand, which is
 *   why the number is left as it was taken rather than quietly modernised.
 *   They are now covered by `workspace.test.ts`'s `grabFor`
 *   describe, which moved the guards out of `App.tsx` and exercises each by
 *   name — `refuses when the boxes are the same length but not the same
 *   panes` fails the moment the two identity guards are deleted, and
 *   `refuses a longer kid list even when the boxes match it pane for pane`
 *   fails the moment the length guard is, and only it;
 * - **the floor derivation was here too** — `axisCells = grid.cols / low.share`,
 *   and the `minRatioFor` call it fed. It was new arithmetic living in
 *   `App.tsx` with no unit test anywhere, and the `minRatioFor(` token this
 *   file used to assert on was measured to be a bare one: swapping its two
 *   arguments passed, and so did turning that `/` into a `*`. Both moved into
 *   `grabFor` in `workspace.ts` and are now pinned as arithmetic, not text:
 *   `measures a col tab down the other axis, against the other floor` fails
 *   under either mutation — under the argument swap because the wrong floor
 *   is measured against the wrong axis, and under `*` because the result
 *   comes out as 1/3 instead of 5/60;
 * - **where the divider lands — covered since this branch.** `offset` is a
 *   cumulative sum computed in `App.tsx` and turned into a percentage at
 *   runtime. A wrong sum draws the strip over the wrong seam — or at the tab's
 *   leading edge — and every assertion in this file still passes. That was
 *   measured, not assumed: see the list below. What sees it now is one line of
 *   `tests/e2e/splits.spec.ts`, which reads the strip's own `boundingBox()`
 *   before touching it and compares its middle against the left pane's
 *   trailing edge.
 *
 * Two of those are still nobody's — the cursor changing, and React calling the
 * cleanup — and for those two a human with the app open really is the only
 * thing that sees them. Same trade as `appLayout.test.ts`, and the same reason.
 * Every other bullet names where it is covered, and three of them now name
 * `tests/e2e/splits.spec.ts`.
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
 * edge. Twelve of twelve green both times — re-measured 2026-08-03 against this
 * file as it now stands, because the count in this paragraph said eleven for as
 * long as it took a twelfth test to be added without it.
 *
 * **What does tell you is `tests/e2e/splits.spec.ts`**, and that is measured the
 * same day rather than hoped for. Its seam-placement assertion fails under both
 * edits, by 423.5 pixels against a 6px bound. The first fails there and nowhere
 * else in that file (1 failed, 6 passed): it moves `offset` alone. The second
 * also changes which seam the gesture grabs, because every strip stacked at the
 * same x makes the press hit-test to whichever painted last, so it takes both
 * three-pane tests with it (3 failed, 4 passed).
 *
 * So if you are changing either, a red `splits.spec.ts` is the real failure and
 * not a flake, and this header is not permission to dismiss it. It once said no
 * test could see placement, which was true when it was written and would have
 * been read as exactly that permission.
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
    expect(app).toMatch(/grabFor\(/)
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

describe('a drag is written to disk once it ends', () => {
  // Until this describe existed, nothing anywhere asserted the commit call:
  // `grep -rn "setLayout\|onCommit\|commitLayout" tests/` returned nothing,
  // and deleting `window.prcli.setLayout(...)` from `commitLayout`, or
  // unwiring `onCommit` from `PaneDivider`, both left the full suite — 508
  // unit, 255 integration, at the time this was measured — green. Neither
  // mutation touches `resizeKids` or `state.tabs`, which is why the gesture
  // itself staying correct on screen hid the write to disk going missing.

  it('commitLayout writes the row through window.prcli.setLayout', () => {
    // Measured: deleting the whole `window.prcli.setLayout(tabId,
    // Object.fromEntries(...))` call from `commitLayout` fails only this
    // assertion — nothing else in this file or `workspace.test.ts` reaches
    // main's IPC boundary at all.
    expect(app).toMatch(/window\.prcli\.setLayout\(/)
  })

  it('wires PaneDivider\'s onCommit to commitLayout, not to a no-op', () => {
    // Measured: replacing `onCommit={() => commitLayout(group.id)}` with
    // `onCommit={() => {}}`, or dropping the prop outright, fails only this
    // assertion — `PaneDivider` calls `onCommit` unconditionally on release
    // (see the listener test above), so an unwired prop is silently a no-op
    // and every other assertion here is indifferent to it.
    expect(app).toMatch(/onCommit=\{\(\) => commitLayout\(/)
  })

  it('sends a record built from row.layout.kids paired with row.layout.ratio, not just some call', () => {
    // The previous test only sees THAT `window.prcli.setLayout(` appears —
    // sending `{}`, or pairing the ratio to the wrong ids, leaves it green.
    // Three bare-token pins, in the style of the arithmetic assertions above:
    // not a full parse, but each one names a specific piece of the pairing.
    //
    // Measured against the real file: deleting `Object.fromEntries(` and
    // sending `{}` in its place fails only this assertion's first line.
    // Changing `row.layout.kids.map(` to build the record from anything else
    // (`state.tabs.map(`, a hand-written literal) fails only the second.
    // Indexing `row.layout.ratio` by anything other than the SAME `index`
    // `kids.map` iterates on — `[0]`, a second `.indexOf(id)` — fails only the
    // third; that is the one that would silently pair a kid with the wrong
    // pane's share.
    expect(app).toMatch(/Object\.fromEntries\(/)
    expect(app).toMatch(/row\.layout\.kids\.map\(/)
    expect(app).toMatch(/row\.layout\.ratio\[index\]/)
  })
})
