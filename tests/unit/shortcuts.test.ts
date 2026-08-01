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
 * **Edits that will fail this without anything being wrong.** Measured against
 * the real files, not inferred:
 *
 * - reformatting the `MenuCommand` union onto one line per member with the
 *   `|` trailing rather than leading — the parse assertion. Both `= 'a' | 'b'`
 *   and `= | 'a' | 'b'` are read; a `|` at the end of a line is not.
 * - moving the keydown handler out of `App.tsx` into its own module — every
 *   assertion in the `App.tsx` block. This test reads files by path; it
 *   follows the code nowhere.
 * - putting a menu item's `accelerator` and its `registerAccelerator` in
 *   different objects, or nesting an object literal inside a menu item — the
 *   accelerator assertion reads one `{...}` at a time.
 *
 * Measured in the other direction too, and all still green: renaming
 * `activePaneId`, `splitActive` or `focusPane`; reordering the four arrows;
 * reordering or renaming any menu item id; adding a menu item without an
 * accelerator; and rewrapping or reindenting any of the three files.
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
    // Each menu item that names an accelerator, one `{...}` at a time — menu
    // items hold no nested object literals, so a brace pair is an item.
    const accelerated = main.match(/\{[^{}]*\baccelerator:[^{}]*\}/g) ?? []
    // Ten of them at the time of writing. Zero would mean the regex had
    // stopped matching menu items and every assertion below was vacuous.
    expect(accelerated).not.toHaveLength(0)
    for (const item of accelerated) {
      // The keystroke has to reach the renderer. An accelerator the menu
      // registers fires the menu item INSTEAD, which for ⌘D and the arrows
      // would take the key off whatever is running in the focused pane.
      expect(item).toContain('registerAccelerator: false')
    }
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
