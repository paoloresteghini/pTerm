import { useCallback, useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { languageForPath } from './lib/languageForPath'
import { GUTTER_TEXT, syntaxColorStyle } from './lib/syntaxColors'
import type { PaneColor } from '../shared/paneColors'
import type { ThemeId } from '../shared/themes'
import { xtermTheme } from './lib/xtermTheme'

/**
 * Every mounted editor pane's save function, by pane id.
 *
 * A module-level map, the same shape `Terminal.tsx` uses for `paneGrid`: ⌘S
 * lands in `App.tsx`, which holds no reference to any editor and has to name
 * the pane it is saving by id alone.
 *
 * Holds the pane's own `save` closure rather than the bare `EditorView`.
 * `Terminal.tsx` can answer `paneGrid` straight off the `XTerm` it stores
 * because cols and rows are the terminal's own properties; a save is not a
 * property of an `EditorView`, it needs this pane's `mtime` and `baseline`
 * refs, its `setRefused`, and its `projectId`/`relPath`, none of which the
 * view carries. Storing the closure is what lets `saveEditorPane` stay a
 * one-line lookup with no ref chain, matching `paneGrid`'s shape instead of
 * reinventing one.
 */
const mounted = new Map<string, () => Promise<void>>()

/**
 * Save the pane `paneId` is showing, or do nothing if none is mounted.
 *
 * Null rather than throwing: a ⌘S that races a pane's unmount (the tab
 * closed between the keydown and this running) has nothing to save, and
 * that is not an error.
 */
export function saveEditorPane(paneId: string): Promise<void> {
  return mounted.get(paneId)?.() ?? Promise.resolve()
}

/**
 * How an editor pane is painted, given the colour of the pane it sits in.
 *
 * A function rather than a constant because the pane's background is a
 * runtime value, and a named function rather than an inline object because
 * two places call it: the effect that builds the view, and the one that
 * reconfigures it when the pane is recoloured.
 *
 * Every entry was measured 2026-08-05 by building the app with the entry
 * removed and reading `getComputedStyle` off the real elements in a running
 * window. None of them is decoration.
 *
 * The foreground on `&`. Without it the content computes `rgb(0, 0, 0)`
 * over a `rgb(9, 9, 11)` pane, about 1.06:1, which is not dim text but
 * invisible text: CodeMirror's base theme sets no foreground at all, and
 * nothing between this element and `<html>` does either.
 *
 * It comes from `xtermTheme`, the same function that tells xterm what to draw,
 * so an editor pane and a terminal pane in one row read as the same surface.
 * That used to be a hardcoded `#d4d4d8` matching a literal in `Terminal.tsx`;
 * both now read the theme instead, which is what lets the pair stay in step
 * across five palettes rather than only in the one they were written against.
 * `PANE_COLORS` were chosen against that foreground, and the requirement did
 * not go away: `tests/unit/themes.test.ts` holds every theme's foreground
 * above 7:1 on every one of the six.
 *
 * `backgroundColor` on `.cm-gutters`, and NOT on `&`. The pane box in
 * `App.tsx` already paints itself `pane.color`, so `&` needs nothing: measured
 * without it, `.cm-editor` is `rgba(0, 0, 0, 0)` and the box shows through
 * correctly. The gutter is the opposite case, because CodeMirror paints that
 * one itself: measured without this line it is `rgb(245, 245, 245)`, a
 * near-white strip down the left of a near-black pane.
 *
 * `color: GUTTER_TEXT` on the same rule, and NOT the `text-faint` (#3f3f46)
 * this shipped with. Computed 2026-08-05 with `tests/unit/contrast.ts`,
 * #3f3f46 is 1.905:1 on the default pane and 1.116:1 on `#38383d`, which is
 * the same hex at the same numbers that the `editor-missing` note further down
 * this file records this repo rejecting as invisible. The replacement carries
 * its own stated bar and its own test; both are at `GUTTER_TEXT`.
 *
 * **The font stack and size sit on `.cm-scroller`, the element the base theme
 * sets `fontFamily: monospace` on and the common ancestor of the content and
 * the gutters. Naming a REAL family there is the half that matters.** Two
 * configurations, both measured 2026-08-05 in a running window with one probe:
 *
 * - size and family on `.cm-content` alone, with nothing above it, which is
 *   what this file shipped at first: `.cm-gutters` and the line numbers
 *   computed 13px generic `monospace` beside 11px `ui-monospace` code, a
 *   different typeface 18 per cent larger than the text it numbers;
 * - the same, plus an explicit `font-size` on the host `<div>`, which is what
 *   the plan's `text-[11px]` there would have done: `.cm-gutters` computed
 *   11px generic `monospace`. The size matched. The typeface still did not.
 *
 * So generic `monospace` DOES inherit an ancestor's explicit size, and the
 * 13px belongs to the first configuration rather than to the plan's.
 *
 * Where the 13px comes from was then probed on its own rather than reasoned
 * about, by putting bare `<div>`s on the page with no `font-size` declared
 * anywhere in their chain and reading what each computed:
 *
 * - `font-family: monospace` and nothing else: 13px
 * - no family of its own: 16px
 * - `font-family: ui-monospace, Menlo, monospace`: 16px
 * - `font-family: monospace`, under an ancestor at `11px`: 11px
 *
 * So it is the BARE GENERIC family that pulls 13px, from the browser's
 * fixed-font setting rather than its proportional one, and only while nothing
 * above declares a size. A stack that merely ENDS in `monospace` does not do
 * it. Which is why naming a real family here settles the size as well as the
 * typeface, and why the base theme's lone `monospace` was the whole cause.
 *
 * `{ dark: true }` picks the base theme's `&dark` rules over its `&light`
 * ones, which is a legibility fix and not a naming preference. Measured under
 * `&light`: the caret computes `rgb(0, 0, 0)` on a near-black pane, so the
 * editor you can type into has a cursor you cannot see, and ⌘F's search panel
 * opens `rgb(245, 245, 245)` with black text. Under `&dark` those are
 * `rgb(255, 255, 255)` and `rgb(51, 51, 56)` with white text.
 */
function themeFor(theme: ThemeId, paneColor: PaneColor | undefined): Extension {
  // The pane's own colour when it has one, the theme's canvas when it does
  // not, and the theme's foreground either way. CodeMirror needs real values
  // here rather than `var(--color-bg)`, because these are written into a
  // generated stylesheet rather than resolved against the document.
  const { background, foreground } = xtermTheme(theme, paneColor)
  return EditorView.theme(
    {
      '&': { color: foreground, height: '100%' },
      '.cm-scroller': {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, 'pTerm Symbols', monospace",
        fontSize: '11px',
      },
      '.cm-gutters': { backgroundColor: background, color: GUTTER_TEXT, border: 'none' },
      // The base theme's own focus ring is `1px dotted #212121`. This app
      // marks a focused pane differently, with an inset accent ring on the box
      // (`App.tsx`).
      '&.cm-focused': { outline: 'none' },
    },
    { dark: true },
  )
}

/**
 * One file, in an editor.
 *
 * The read happens here rather than in `App.tsx` so a pane fetches its own
 * file when it mounts, including after a relaunch, where nothing else knows
 * to go and get it.
 *
 * `relPath` is relative because that is what `fsRead` takes; the pane row
 * stores an absolute path and `App.tsx` converts one to the other through
 * `relativeToProject`. Null is that conversion failing (no `filePath` on the
 * pane, or one that does not sit inside its project), and it draws the same
 * thing a deleted file does, since from here they are the same sentence.
 *
 * ⌘S is the only thing that writes. It arrives through `mounted`, which `save`
 * below registers this pane in, and nothing here writes on a timer, on blur or
 * on close: typing reaches the document and stays there until the user asks
 * for it to go to disk.
 */
export function FileView({
  projectId,
  relPath,
  paneColor,
  theme,
  paneId,
  onDirtyChange,
}: {
  projectId: string
  relPath: string | null
  /** The pane's own background, or undefined when it has none of its own. */
  paneColor?: PaneColor
  /** The palette in force. Supplies the gutter ground and the text colour. */
  theme: ThemeId
  paneId: string
  onDirtyChange: (paneId: string, dirty: boolean) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  // The mtime the text on screen was read at, and what a save was refused
  // for. Both null together outside a refusal: `mtime` starts null until the
  // first `fsRead` resolves, and a save before then has nothing to compare
  // against, which is why `save` below refuses to run while it is.
  const mtime = useRef<number | null>(null)
  const [refused, setRefused] = useState<null | 'changed' | 'missing' | 'failed'>(null)
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // One compartment for the life of the pane, not one per view. A compartment
  // is just a key that a state and a later reconfigure have to agree on, so it
  // has to outlive any single `EditorView` the pane builds.
  const themes = useRef(new Compartment())
  // The document the view was BUILT with, not the current one: dirty is
  // "differs from what was read", so this has to stay put while the document
  // changes around it. Kept in step with `text` rather than read from it,
  // because `text` itself must never be written again after the first read
  // (see the build effect below) and this is the one place a new baseline
  // (a successful save, Task 4) can land without disturbing that rule.
  const baseline = useRef(text ?? '')

  useEffect(() => {
    if (relPath === null) {
      setMissing(true)
      return
    }
    // BOTH cleared before the fetch, not left from the previous path: nothing
    // in this slice ever changes a pane's file, but a component that answers
    // for the file it was last asked about is not a thing to leave lying
    // around for the slice that does. Clearing only `missing` would have been
    // half of that, and the visible half is the one left behind: the pane would
    // go on rendering the OLD file's text until the new read resolved.
    setMissing(false)
    setText(null)
    setRefused(null)
    mtime.current = null
    let live = true
    window.pterm
      .fsRead(projectId, relPath)
      .then((found) => {
        if (!live) return
        if (found === null) setMissing(true)
        else {
          setText(found.text)
          mtime.current = found.mtimeMs
        }
      })
      // Swallowed like the tree's own fetch: a file that will not read is a
      // pane that says so, and this is not where transport faults get
      // reported.
      .catch(() => {
        if (live) setMissing(true)
      })
    return () => {
      // The same guard `FileTree` needed after its review: a fetch resolving
      // after the pane changed file must not write into the new one.
      live = false
    }
  }, [projectId, relPath])

  /**
   * The editor, built once per file and destroyed on unmount.
   *
   * `text` is the INITIAL document and nothing else. Re-running this effect
   * rebuilds the view from scratch, which throws away whatever is in it, so
   * nothing may set `text` again after the first read while a pane is open:
   * doing so would wipe the user's typing mid-keystroke. The fetch effect
   * above only writes it once per `relPath`, and Task 3's dirty tracking has
   * to keep it that way.
   *
   * **Neither `paneColor` nor `theme` is a dependency here.** `paneColor` was,
   * and that was a data-loss bug waiting for the next task: recolouring a pane
   * from its right-click menu re-ran this effect, and the rebuild dropped
   * whatever had been typed back to what was read from disk. Both live in a
   * `Compartment` instead, reconfigured in place by the effect below, so
   * neither a recolour nor a theme switch touches the document. `themes` is a
   * ref rather than a value so the same compartment key survives a rebuild for
   * a new file.
   *
   * Reading them without depending on them is safe rather than stale: this
   * closure is the one from the render it runs in, so a build always uses the
   * current pair, and any LATER change arrives through the reconfigure.
   *
   * **`onDirtyChange` and `paneId` join the dependency list below, and the
   * same rule as `paneColor` almost bit this: an unstable `onDirtyChange` would
   * rebuild the view, and therefore drop the cursor, on every render. Unlike
   * `color` there is no compartment side-step available, because an update
   * listener has to be part of the state a view is created with. So the fix
   * here is at the caller: `App.tsx` wraps the handler in `useCallback` so it
   * is the same function across renders and this effect only re-runs when the
   * pane itself changes.
   */
  useEffect(() => {
    if (text === null || host.current === null) return
    baseline.current = text
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        // Our own palette, not `defaultHighlightStyle`, which is CodeMirror's
        // LIGHT-background one and measured worse than no highlighting at all
        // on these panes. The numbers, the bar and the reasons are at
        // `SYNTAX_COLORS`, and `tests/unit/syntaxColors.test.ts` enforces
        // them.
        //
        // `fallback: true` still: it makes this the style used when a language
        // brings no highlighter of its own, which is every language here.
        syntaxHighlighting(syntaxColorStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        ...languageForPath(relPath ?? ''),
        themes.current.of(themeFor(theme, paneColor)),
        // The baseline is the document the view was created with, so dirty is
        // "differs from what was read", not "was typed in". Typing a
        // character and deleting it again leaves the pane clean, which is
        // what the dot has to mean for the close prompt (Task 5) to be worth
        // showing.
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          onDirtyChange(paneId, update.state.doc.toString() !== baseline.current)
        }),
      ],
    })
    const created = new EditorView({ state, parent: host.current })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
      // A closed or replaced pane leaves nothing behind in the dirty map:
      // without this, closing a dirty editor tab would leave its id in
      // `App.tsx`'s map forever, since nothing else ever clears it for a
      // pane that no longer exists.
      onDirtyChange(paneId, false)
    }
  }, [text, relPath, paneId, onDirtyChange])

  /**
   * A recolour or a theme switch, applied without rebuilding anything.
   *
   * The whole reason the theme is compartmented. On the first render there is
   * no view yet and this does nothing; the build above runs first and already
   * has the right pair in it.
   *
   * Two triggers, for the two ways this pane's ground can move: the user
   * recolours the pane, or the palette changes under it.
   */
  useEffect(() => {
    view.current?.dispatch({ effects: themes.current.reconfigure(themeFor(theme, paneColor)) })
  }, [theme, paneColor])

  const save = useCallback(async () => {
    const current = view.current
    if (current === null || relPath === null || mtime.current === null) return
    const written = current.state.doc.toString()
    const result = await window.pterm.fsWrite(projectId, relPath, written, mtime.current)
    if (result.ok) {
      // **The invariant: the baseline is what is on disk, and the dirty flag is
      // the document compared against that same baseline, decided at the same
      // moment.** The two lines below are the only place both move, and they
      // say it in one expression each so they cannot disagree.
      //
      // `written` is the right baseline: it is exactly the bytes this write put
      // on disk, and the pane is clean when it matches them. What is NOT safe
      // is to conclude "clean" from having written: nothing blocks typing
      // during the await above, so the document may have moved on since the
      // snapshot. Reporting clean unconditionally left a pane holding
      // characters that were on no disk with its dot off, and
      // `requestClosePane` then closed it without asking, destroying them
      // silently. So the flag is recomputed against the document as it is NOW.
      baseline.current = written
      mtime.current = result.mtimeMs
      setRefused(null)
      onDirtyChange(paneId, current.state.doc.toString() !== baseline.current)
      return
    }
    setRefused(result.reason)
  }, [projectId, relPath, paneId, onDirtyChange])

  /**
   * Reload from disk, discarding whatever is typed. `text` cannot be
   * reassigned to do this: the build effect above treats it as the initial
   * document only, and setting it again would re-run that effect and rebuild
   * the view mid-session. `dispatch` with a change spanning the whole
   * document mutates the existing view in place instead, which is reachable
   * from here and does not touch the compartment holding the theme.
   *
   * **A file that has gone by the time this runs sets `refused`, where the
   * opening fetch sets `missing`.** The difference is what is at stake: this
   * pane has a built view with the user's typing in it, and `missing`
   * short-circuits the render below, which unmounts the host without running
   * the build effect's cleanup (its dependencies have not changed). That left
   * the document alive but unreachable, the dot on with nothing behind it, and
   * ⌘S a silent no-op, because the banner it sets is behind that same early
   * return. `refused` sits ABOVE the editor for exactly the reason written at
   * the banner: unsaved text is what this is here to protect. A file that was
   * never there at mount has no typing to protect, so the opening fetch keeps
   * `missing`.
   */
  const reload = useCallback(() => {
    if (relPath === null) return
    window.pterm
      .fsRead(projectId, relPath)
      .then((found) => {
        if (found === null) {
          setRefused('missing')
          return
        }
        // Set before the dispatch below, not after: the update listener
        // reads `baseline.current` synchronously inside `dispatch`, and
        // setting it first is what keeps that listener from reporting the
        // pane dirty for the one tick between the two.
        baseline.current = found.text
        mtime.current = found.mtimeMs
        const current = view.current
        if (current !== null) {
          current.dispatch({
            changes: { from: 0, to: current.state.doc.length, insert: found.text },
          })
        }
        setRefused(null)
        onDirtyChange(paneId, false)
      })
      // The same sentence for a read that faults as for one that answers null,
      // which is the conflation the opening fetch already makes ("a file that
      // will not read is a pane that says so"). Not `'failed'`: that banner
      // reads "could not be written", and nothing here was being written.
      .catch(() => setRefused('missing'))
  }, [projectId, relPath, paneId, onDirtyChange])

  // Registered and deregistered here rather than inside the view-build
  // effect above: `save` closes over `projectId`, which is not one of that
  // effect's dependencies (a pane's project never changes), so tying
  // registration to `save`'s own identity is the one that cannot go stale.
  // The identity guard mirrors `Terminal.tsx`'s: without it, a remount that
  // runs this effect before the old one's cleanup would delete the live
  // entry, and `saveEditorPane` would answer "nothing mounted" for a pane
  // still on screen.
  useEffect(() => {
    mounted.set(paneId, save)
    return () => {
      if (mounted.get(paneId) === save) mounted.delete(paneId)
    }
  }, [paneId, save])

  if (missing) {
    return (
      <div
        data-testid="editor-missing"
        // `text-term-fg`, and NOT the `text-faint` that is this app's token for
        // secondary text, which is a deliberate departure from the convention
        // rather than drift. This string is not an annotation beside content,
        // it IS the pane's entire content, and it reports a failure the user
        // has to read to understand why their file is not on screen.
        //
        // Measured 2026-08-04: `text-faint` (#3f3f46) is about 1.9:1 on the
        // default pane and about 1.1:1 if the user right-clicks that pane and
        // picks #38383d, which is invisible. `text-muted` was the smaller step
        // and was rejected by the same measurement: 4.1:1 on the default pane
        // but only 2.4:1 on that same colour, which repeats the defect in a
        // quieter voice. `text-term-fg` is 13.5:1 and 7.89:1, the second being
        // the number `paneColors.ts` already records for its worst case.
        //
        // Everywhere else in the app `text-faint` stays what it is: this is one
        // instance departing, not a convention being rewritten.
        className="p-3 font-mono text-[11px] text-term-fg"
      >
        That file is no longer there.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Above the editor rather than replacing it: the user's unsaved text
          is the thing this exists to protect, so it has to stay on screen
          while the banner is up, not get swapped out for a message. */}
      {refused !== null && (
        <div
          data-testid="editor-refused"
          className="border-b border-border bg-surface px-3 py-2 text-[11px] text-fg"
        >
          {refused === 'changed'
            ? 'That file changed on disk since you opened it. Your edits are still here.'
            : refused === 'missing'
              ? 'That file is no longer there. Your edits are still here.'
              : 'That file could not be written.'}
          {refused === 'changed' && (
            <button data-testid="editor-reload" onClick={reload} className="ml-2 underline">
              Reload and lose my edits
            </button>
          )}
        </div>
      )}
      {/* `editor-content` is on the host rather than on anything CodeMirror
          makes, because CodeMirror owns everything under here and replaces
          it freely. The testid is the same one the `<pre>` carried and B1's
          e2e still reads text off it: measured 2026-08-05, `textContent`
          here is the gutter's line numbers followed by the document, so a
          `toContainText` on a file's text still passes. Only for a document
          that fits on screen, though: CodeMirror renders a window rather
          than the whole file, and a seeded 4000-line file measured 80 lines
          and 1012 characters in the DOM. Every fixture in this suite is two
          lines, so nothing asserts past that today. */}
      <div
        data-testid="editor-content"
        ref={host}
        className="scroll-thin min-h-0 flex-1 overflow-auto"
      />
    </div>
  )
}
