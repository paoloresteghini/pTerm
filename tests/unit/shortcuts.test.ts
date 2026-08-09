import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * The wiring behind ⌘D, ⇧⌘D, ⌘W and the ⌘⌥arrows, checked against the source
 * text because nothing in this suite can press a key.
 *
 * `vitest.config.mts` runs in `environment: 'node'`: no DOM, no window to
 * dispatch a `keydown` at, and no Electron menu to click. What movement means
 * is unit-tested properly, in `paneInDirection` (workspace.test.ts). What is
 * left over is the part that decides whether those functions are ever reached:
 * *that the keystrokes are handled in the renderer rather than claimed by a
 * menu accelerator*, *that every menu command the type declares is both sent
 * and handled*, and *that the pane the app calls active is the one that takes
 * DOM focus*. A grep is a poor test; it is better than the nothing that is
 * otherwise on offer here — the same trade `appLayout.test.ts` makes, and it
 * carries the same duplicated `readCode`, which is five lines and no more
 * shared for being imported.
 *
 * The first of those three is the one worth the file on its own. A registered
 * accelerator is invisible in every test that exists and shows up as Claude
 * missing a keystroke the user typed at it.
 *
 * **Edits that will fail this without anything being wrong.** Each was made
 * against the real files and the result counted, so this list is measured
 * rather than inferred:
 *
 * - renaming the `MenuCommand` type — 2 of the 3 menu assertions. Both are
 *   the same parse, which anchors on the name.
 * - composing that union out of a second named type (`| PaneCommand |`) — 1.
 *   The parse stops at the first member that is not a string literal, and the
 *   members it can no longer see stop being checked at all, so failing is the
 *   answer that keeps this honest.
 * - renaming `splitActive` — 1, the axis assertion, which reads the call as
 *   well as the branch. `activePaneId` and `focusPane` are not read by name.
 * - reordering the operands of a modifier gate — the handler reads
 *   `event.code === 'KeyD' && !event.altKey`, and writing the same guard the
 *   other way round would fail the gate assertion. Deliberately not loosened:
 *   matching the two operands independently would stop the assertion saying
 *   that this binding is gated on that modifier, which is the whole of what it
 *   says. Reordering a `&&` is a deliberate edit; re-point the assertion. All
 *   three letter bindings are spelled the one way for the same reason — one
 *   guard with two spellings is a guard nothing pins.
 * - moving any of these files, or moving the keydown handler out of `App.tsx`
 *   into a module of its own. This test reads files by path; it follows the
 *   code nowhere.
 *
 * Measured in the other direction too, and all still green: renaming
 * `activePaneId`; reordering the four arrows; renaming a menu item id; adding
 * a menu item with no accelerator; putting a comment between two members of
 * the union; and writing that union on one line, with the `|` leading or
 * trailing — comments are stripped and whitespace flattened before anything
 * is read, which is what makes those last three the same text.
 *
 * One tolerance is worth knowing about, because it was measured rather than
 * assumed: wrapping a menu item's `click` in a braced body takes that item out
 * of the per-object accelerator check, which reads one brace pair at a time.
 * The count beside it still covers the item — with the count assertion removed,
 * a braced item that registers its accelerator passes; with it, it fails.
 */

/**
 * Comments out, then whitespace flattened — `appLayout.test.ts`'s helper, for
 * its reasons: a comment that merely mentions one of these strings must not be
 * able to satisfy or to fail an assertion about the code, and reindenting and
 * rewrapping must read the same. No string literal in these files contains
 * `//`, so nothing else goes with the comments.
 */
function readCode(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

const app = readCode('../../src/renderer/App.tsx')
const main = readCode('../../src/main/index.ts')
const shared = readCode('../../src/shared/ipc.ts')
const terminal = readCode('../../src/renderer/Terminal.tsx')

/**
 * The source of a function, from its declaration to the closing bracket of
 * the outer call that defines it — every case this file scopes is a
 * `useCallback(...)`. Generic depth over all three bracket types together,
 * not `(` counted separately from `{` and `[`: well-formed code cannot close
 * one kind out of order with another, so a single counter still lands on the
 * true match without having to know which kind opened it.
 *
 * Bounding matters here for the reason `elements()` bounds a JSX tag in
 * appLayout.test.ts: matching a constant against the whole file passes
 * whether or not the function under test does anything with it. `grabPane`
 * (Task 4) already uses `MIN_PANE_COLS` a few hundred characters below
 * `splitActive` — an assertion that never scoped past `app` itself would be
 * satisfied by that alone, refusal or no refusal.
 */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  expect(start).not.toBe(-1)
  const openAt = source.indexOf('(', start)
  expect(openAt).not.toBe(-1)
  let depth = 0
  let i = openAt
  for (; i < source.length; i++) {
    if ('([{'.includes(source[i])) depth++
    else if (')]}'.includes(source[i])) depth--
    if (depth === 0) {
      i++
      break
    }
  }
  if (depth !== 0) throw new Error(`No matching close for ${declaration}`)
  return source.slice(start, i)
}

/** Every member of the `MenuCommand` union, in declaration order. */
function menuCommands(): string[] {
  const union = /export type MenuCommand =\s*\|?\s*('\w+'(?:\s*\|\s*'\w+')*)/.exec(shared)
  expect(union).not.toBeNull()
  return [...(union?.[1] ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1])
}

describe('menu accelerators', () => {
  it('declares commands for the pane bindings', () => {
    const commands = menuCommands()
    // Non-empty first, and then some: every assertion below is a loop over
    // this list, and a parse that came back with nothing — or with only the
    // three commands that predate splits — would make all of them vacuous.
    expect(commands).not.toHaveLength(0)
    expect(commands).toEqual(
      expect.arrayContaining([
        'closePane',
        'splitRight',
        'splitDown',
        'focusLeft',
        'focusRight',
        'focusUp',
        'focusDown',
      ]),
    )
  })

  it('sends every command it declares, and handles every one it sends', () => {
    const commands = menuCommands()
    expect(commands).not.toHaveLength(0)
    for (const command of commands) {
      // A command with no menu item is a renderer case nothing can reach; a
      // menu item with no case is an item that does nothing when clicked,
      // which is the defect the whole `menuCommand` channel exists to fix.
      expect(main).toContain(`sendMenuCommand('${command}')`)
      expect(app).toContain(`case '${command}':`)
    }
  })

  it('never claims an accelerator from the window', () => {
    // Two readings of the same rule, because each covers the other's blind
    // spot. Every item that names an accelerator, one `{...}` at a time —
    // which only sees items holding no nested braces, so an item whose
    // `click` grew a braced body drops silently out of this set...
    const accelerated = main.match(/\{[^{}]*\baccelerator:[^{}]*\}/g) ?? []
    // ...ten of them when this was written. Zero would mean the regex had
    // stopped matching menu items and the loop below was vacuous.
    expect(accelerated).not.toHaveLength(0)
    for (const item of accelerated) {
      // The keystroke has to reach the renderer. An accelerator the menu
      // registers fires the menu item INSTEAD, which for ⌘D and the arrows
      // would take the key off whatever is running in the focused pane.
      expect(item).toContain('registerAccelerator: false')
    }
    // ...and a straight count, which sees every item but not which opt-out
    // belongs to which accelerator. `\b` keeps this off `registerAccelerator`,
    // whose own capital A cannot match a lowercase one.
    //
    // One more opt-out than there are accelerators: the tabs column's item
    // opts out with no accelerator to opt out of (it has no keystroke at
    // all). Exact, not `>=`: with slack in the count, the first
    // accelerator-bearing item that forgets to opt out lands inside the
    // slack and this goes quiet. Measured 2026-08-09 against this file:
    // 17 `accelerator: '` and 18 `registerAccelerator: false`.
    const declared = main.match(/\baccelerator: '/g) ?? []
    const unregistered = main.match(/registerAccelerator: false/g) ?? []
    expect(declared).not.toHaveLength(0)
    expect(unregistered).toHaveLength(declared.length + 1)
    expect(main).not.toMatch(/registerAccelerator: true/)
  })
})

describe('App.tsx keydown handler', () => {
  it('matches on event.code, never on event.key', () => {
    // On macOS ⌥ rewrites `key` — ⌥⌘1 arrives as "¡" — so a key-based check
    // silently never fires. One rule for every binding in the handler.
    expect(app).toMatch(/event\.code === 'KeyD'/)
    for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(app).toContain(code)
    }
    expect(app).not.toMatch(/event\.key\b/)
  })

  it('picks the split axis with ⇧, in that direction', () => {
    // ⇧⌘D is the only way a `col` tab is ever created. A branch that read the
    // other way would leave the whole column half of the layout unreachable
    // and would still pass every other assertion in this suite — it fails
    // visibly on the first press, but only if someone presses it.
    // Loosened where loosening costs nothing: an optional space after the
    // paren, and no closing paren at all, so wrapping the call across lines —
    // which a reformat does by adding a trailing comma — reads the same. What
    // is left is the whole of what this asserts.
    expect(app).toMatch(/splitActive\( ?event\.shiftKey \? 'col' : 'row'/)
  })

  it('sends the axis the key asked for, and measures along that same axis', () => {
    // This used to assert the opposite: the renderer read the tab's own axis
    // off `state` and sent that, mirroring a ruling main applied by counting
    // the kids on its saved row. The ruling was reversed on 2026-08-06 because
    // it made a `col` tab impossible to split right ever again, silently. Both
    // halves of the override are gone, so what is left to hold is that the
    // request travels intact.
    // The override is gone, stated as its absence: this is the assertion that
    // fails if anyone reinstates it.
    expect(app).not.toMatch(/row\.layout\.dir : dir/)
    // And the request is forwarded as-is rather than through a local decision.
    // `app` arrives with comments stripped and whitespace collapsed to single
    // spaces, so this is one line here however the file is formatted.
    expect(app).toMatch(/paneId: activePaneId, dir,/)
    // And the measurement has to follow the SAME axis it sends. Halving along
    // one axis while splitting along the other hands the new window a size
    // nobody drew — the geometry class this codebase has shipped three times.
    expect(app).toMatch(/dir === 'row' \? half\(grid\.cols\)/)
    expect(app).toMatch(/dir === 'col' \? half\(grid\.rows\)/)
    // Measured rather than assumed: reintroducing the override, or measuring
    // against one axis while sending the other, fails here. Renaming `dir` or
    // `grid` fails it too without anything being wrong; re-point the assertion
    // rather than loosening it, because naming both ends is the whole of what
    // it says.
  })

  it('keeps the ⌥ chords out of the bindings that are not ⌥ chords', () => {
    // ⌥ held makes it a different chord — ⌥⌘digit picks a tab, ⌘⌥arrow moves
    // a pane — so none of the letter bindings may fire while it is down.
    for (const code of ['KeyT', 'KeyW', 'KeyD']) {
      expect(app).toMatch(new RegExp(`event\\.code === '${code}' && !event\\.altKey`))
    }
    // And the arrows are the ⌥ chord itself, with ⇧ excluded so ⇧⌘⌥arrow is
    // left for whatever claims it later.
    expect(app).toMatch(/event\.altKey && !event\.shiftKey/)
  })

  it('moves the selection through paneInDirection', () => {
    // Which is where falling off the end is decided, and where it is tested.
    // Arithmetic inlined here would be arithmetic nothing covers.
    expect(app).toMatch(/paneInDirection\(/)
  })
})

describe('focus follows the active pane', () => {
  /**
   * DOM focus is the one thing this suite genuinely cannot observe — there is
   * no DOM — so these two assertions are the whole coverage of it, and they
   * only say the wire is connected at both ends. That the keystroke then goes
   * to the right pty is checked by hand.
   */
  it('is asked for by App and acted on by Terminal', () => {
    expect(app).toMatch(/focused=\{/)
    expect(terminal).toMatch(/if \(!focused\) return/)
    expect(terminal).toMatch(/termRef\.current\?\.focus\(\)/)
  })
})

describe('splitActive refuses a split that would breach the floor', () => {
  it('refuses a split that would breach the floor', () => {
    // The check lives beside the only cell-accurate numbers in the system.
    // Main has no idea what a column is, so it cannot make this call.
    //
    // Scoped to splitActive's own body, not matched against the whole file:
    // Task 4's MIN_PANE_COLS already appears in grabPane's own floor
    // (App.tsx, around line 296), so `expect(app).toMatch(/MIN_PANE_COLS/)`
    // passes today, before splitActive refuses anything at all.
    const body = functionBody(app, 'const splitActive = useCallback(')
    expect(body).toMatch(/MIN_PANE_COLS/)
    expect(body).toMatch(/MIN_PANE_ROWS/)
    // Not a mention — the refusal itself: a halved grid dimension, taken for
    // whichever axis is being split, set against the floor for that same
    // axis, and then actually compared with `<`. Three separate assertions
    // rather than one loose one, so that a refusal which drops one axis, or
    // which compares the wrong pair, fails here instead of sliding through
    // a regex broad enough to match both correct and broken code alike.
    expect(body).toMatch(/half\(grid\.cols\)\s*:\s*half\(grid\.rows\)/)
    expect(body).toMatch(/MIN_PANE_COLS\s*:\s*MIN_PANE_ROWS/)
    expect(body).toMatch(/wouldBe\s*<\s*floor/)
  })
})
