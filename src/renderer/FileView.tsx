import { useCallback, useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { Code2, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isMarkdownPath, languageForPath } from './lib/languageForPath'
import { GUTTER_TEXT, syntaxColorStyle } from './lib/syntaxColors'
import type { PaneColor } from '../shared/paneColors'
import type { ThemeId } from '../shared/themes'
import { xtermTheme } from './lib/xtermTheme'
import { MarkdownDoc } from './ui/MarkdownDoc'
import { editorFontFamily, type FontChoice } from './fonts'

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
 * across six palettes rather than only in the one they were written against.
 * `PANE_COLORS` are dark by design, so `xtermTheme` keeps pale ink whenever a
 * pane explicitly uses one. Its tests hold that ink above 7:1 on every pane
 * colour, while `themes.test.ts` holds each palette's own ink on its canvas.
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
function themeFor(theme: ThemeId, paneColor: PaneColor | undefined, font: FontChoice): Extension {
  // The pane's own colour when it has one, the theme's canvas when it does
  // not, and the theme's foreground either way. CodeMirror needs real values
  // here rather than `var(--color-bg)`, because these are written into a
  // generated stylesheet rather than resolved against the document.
  const { background, foreground } = xtermTheme(theme, paneColor)
  return EditorView.theme(
    {
      '&': { color: foreground, height: '100%' },
      '.cm-scroller': {
        fontFamily: editorFontFamily(font),
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
  font,
  paneId,
  onDirtyChange,
}: {
  projectId: string
  relPath: string | null
  /** The pane's own background, or undefined when it has none of its own. */
  paneColor?: PaneColor
  /** The palette in force. Supplies the gutter ground and the text colour. */
  theme: ThemeId
  /** The editor font selected in Appearance settings. */
  font: FontChoice
  paneId: string
  onDirtyChange: (paneId: string, dirty: boolean) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  /**
   * Which half of a markdown pane is on screen. Ignored for every other file.
   *
   * `'preview'` initially because reading is what opening a `.md` from the
   * tree usually means; the source is a click away and ⌘S still belongs to it.
   * Component state rather than anything persisted: a pane's mode does not
   * survive a relaunch, which is a deliberate omission and not an oversight:
   * `restore` reattaches only the fields `attachSavedFields` names, so
   * persisting this would mean threading it through the pane row, and nothing
   * has asked for that.
   */
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  /**
   * The string the rendered view is painting.
   *
   * Snapshotted rather than read live, because the document lives in
   * CodeMirror and a ref is not something a render can react to. It is taken
   * at the two moments the rendered view can become visible with new content
   * behind it: when a file's text first arrives, and when the toggle flips
   * back to preview. Between those the editor is on screen instead, so there
   * is no stale frame to see.
   *
   * The snapshot comes from the DOCUMENT, not from `text`, so preview shows
   * unsaved edits rather than the copy that was read from disk.
   */
  const [previewSrc, setPreviewSrc] = useState('')
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
    // A new file opens rendered, the same as the first one did. Without this a
    // pane that had been flipped to source would show the NEXT file's source
    // too, which is a mode the user chose for a document they have finished
    // with.
    setMode('preview')
    mtime.current = null
    let live = true
    window.pterm
      .fsRead(projectId, relPath)
      .then((found) => {
        if (!live) return
        if (found === null) setMissing(true)
        else {
          setText(found.text)
          // The first of the two snapshot points. Nothing has been typed yet,
          // so what was read is what preview should show.
          setPreviewSrc(found.text)
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
        themes.current.of(themeFor(theme, paneColor, font)),
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
    view.current?.dispatch({ effects: themes.current.reconfigure(themeFor(theme, paneColor, font)) })
  }, [theme, paneColor, font])

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
        // The rendered view is reachable during a refusal (the banner sits
        // above whichever half is showing), and this is the one path that
        // replaces the document without the toggle being touched. Without
        // this line, discarding your edits would leave preview still painting
        // them.
        setPreviewSrc(found.text)
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

  /**
   * Flip between the rendered document and its source.
   *
   * Going TO preview takes the snapshot, from the live document rather than
   * from `text`, so anything typed and not yet saved is what gets rendered.
   *
   * The measure that source mode needs is NOT done here: see the effect below
   * this one. `setMode` has not reached the DOM yet at this point, so a
   * measure taken now would still be measuring a hidden element.
   */
  const toggleMode = useCallback(() => {
    if (mode === 'source') {
      setPreviewSrc(view.current?.state.doc.toString() ?? text ?? '')
      setMode('preview')
    } else {
      setMode('source')
    }
  }, [mode, text])

  /**
   * Re-measure the editor when it becomes visible.
   *
   * The view is built and kept mounted behind `display: none` while preview is
   * up (the render below says why it is not unmounted instead), so it has
   * measured itself inside a box with no height and cached that.
   *
   * **Measured 2026-09-08 on an 800-line markdown file, by reading the real
   * elements in a running window with this effect present and then removed.**
   * With it, `.cm-content` is 12327px tall and 76 lines are in the DOM; that
   * height is the document's real one (799 lines at the ~15.4px this pane sets).
   * Without it, the same pane reports 11258px and 36 lines: a scrollbar sized
   * for a document about a thousand pixels shorter than the one behind it.
   * Both states show the right TEXT, which is why no assertion about content
   * catches this and why the numbers are written down here.
   *
   * An effect rather than the click handler, because this has to run AFTER
   * React has shown the host: at the click, `setMode` has not reached the DOM
   * and the measurement would be taken against the hidden box again.
   */
  useEffect(() => {
    if (mode === 'source') view.current?.requestMeasure()
  }, [mode])

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

  // A null `relPath` is a pane whose file could not be located at all, which
  // the `missing` branch below draws; `isMarkdownPath('')` is false, so the
  // toggle never appears for one.
  const isMarkdown = isMarkdownPath(relPath ?? '')

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
      {/* The one control markdown panes get, and only markdown panes. Under
          the refused banner rather than above it: the banner reports that
          text is at risk, which outranks a view control.

          `md-toggle` does not begin with `tab-` or `pane-`. Both prefixes are
          counted by `[data-testid^="..."]` matches across the e2e suite, and
          an element under either one inflates every count while each
          assertion still passes. */}
      {isMarkdown && (
        <div className="flex shrink-0 justify-end border-b border-border px-1.5 py-1">
          <Button
            data-testid="md-toggle"
            aria-label={mode === 'preview' ? 'Show markdown source' : 'Show rendered markdown'}
            title={mode === 'preview' ? 'Show markdown source' : 'Show rendered markdown'}
            onClick={toggleMode}
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
          >
            {mode === 'preview' ? <Code2 /> : <Eye />}
            <span>{mode === 'preview' ? 'Source' : 'Preview'}</span>
          </Button>
        </div>
      )}
      {isMarkdown && mode === 'preview' && (
        <div data-testid="markdown-scroll" className="scroll-thin min-h-0 flex-1 overflow-auto">
          <MarkdownDoc source={previewSrc} theme={theme} paneColor={paneColor} />
        </div>
      )}
      {/* **Hidden, never unmounted.** Everything this pane can do lives in the
          `EditorView` inside this host: the document the user has typed into,
          the undo history, the dirty flag `App.tsx`'s close prompt reads, and
          the `save` closure ⌘S arrives through. Rendering the host
          conditionally would destroy all of it on the way into preview and
          rebuild it from `text` on the way back, so a flip to preview and back
          would silently discard unsaved edits, the exact loss the build
          effect above already documents `paneColor` causing before it moved
          into a compartment.

          `hidden` rather than a class, because CodeMirror writes inline styles
          into this subtree and the attribute's `display: none` is one the app
          sets on the host itself. The cost is a view that measures zero while
          it is off screen, which the effect above corrects when it comes back.

          `editor-content` is on the host rather than on anything CodeMirror
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
        hidden={isMarkdown && mode === 'preview'}
        className="scroll-thin min-h-0 flex-1 overflow-auto"
      />
    </div>
  )
}
