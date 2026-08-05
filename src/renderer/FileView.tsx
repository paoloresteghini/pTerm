import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { languageForPath } from './lib/languageForPath'
import { PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'

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
 * Nothing saves yet. Typing reaches the document and goes no further.
 */
export function FileView({
  projectId,
  relPath,
  color = PANE_COLOR_DEFAULT,
}: {
  projectId: string
  relPath: string | null
  color?: PaneColor
}) {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)

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
    let live = true
    window.prcli
      .fsRead(projectId, relPath)
      .then((found) => {
        if (!live) return
        if (found === null) setMissing(true)
        else setText(found.text)
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
   * `color` is in the dependencies for the same reason it is in the theme,
   * and it carries the same cost: recolouring a pane from its right-click
   * menu rebuilds the view and drops the document back to what was read from
   * disk. Harmless today, because nothing here is saved and a rebuild only
   * costs the user a re-read. It stops being harmless once there is unsaved
   * work to lose, so whichever task introduces that has to move the theme
   * into a `Compartment` and reconfigure it instead.
   */
  useEffect(() => {
    if (text === null || host.current === null) return
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        // **`defaultHighlightStyle` is CodeMirror's LIGHT-background palette,
        // and it is a legibility regression on this app's panes.** Measured
        // 2026-08-05 by reading `getComputedStyle(span).color` off the real
        // token spans in a running window: keywords come out `rgb(119, 0, 136)`,
        // definitions `rgb(0, 0, 255)`, literals `rgb(17, 102, 68)`, strings
        // `rgb(170, 17, 17)`. Against `#09090b` those are 2.03:1, 2.32:1,
        // 2.85:1 and 2.65:1, and against `PANE_COLORS`' lightest `#38383d`
        // they are 1.19:1, 1.36:1, 1.67:1 and 1.55:1. The worst entry in the
        // style, `local(variableName)` `#30a`, is 1.05:1 on that pane.
        //
        // For scale: the plain `#d4d4d8` below is 13.46:1 and 7.89:1 on those
        // same two, so EVERY token is harder to read coloured than it would be
        // uncoloured, and `editor-missing` records this repo rejecting a colour
        // at 1.9:1 as invisible. Kept anyway because the fix is a decision
        // rather than a correction: `@codemirror/language` exports no dark
        // style and does not re-export `tags`, so a hand-written
        // `HighlightStyle` needs `@lezer/highlight` declared as an eighth
        // dependency (it is on disk transitively, but importing it from `src/`
        // undeclared would be a hidden dependency that `check-deps` cannot
        // see), and `@codemirror/theme-one-dark` is a whole package for a
        // palette nobody has chosen. Raised with the numbers above rather than
        // settled here.
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        ...languageForPath(relPath ?? ''),
        // Every entry below was measured 2026-08-05 by building the app with
        // the entry removed and reading `getComputedStyle` off the real
        // elements in a running window. None of them is decoration.
        //
        // `color: '#d4d4d8'` on `&`. Without it the content computes
        // `rgb(0, 0, 0)` over a `rgb(9, 9, 11)` pane, about 1.06:1, which is
        // not dim text but invisible text: CodeMirror's base theme sets no
        // foreground at all, and nothing between this element and `<html>`
        // does either. #d4d4d8 is what xterm is handed as its foreground
        // (`Terminal.tsx` repeats the value by hand because a canvas cannot
        // read a CSS variable), so an editor pane and a terminal pane in one
        // row read as the same surface. It is hardcoded rather than taken
        // from `color` because `PANE_COLORS` were chosen against this exact
        // value: its own doc records the worst of the six at 7.89:1, so a
        // recoloured editor pane is covered by a ratio somebody already
        // worked out.
        //
        // `backgroundColor` on `.cm-gutters`, and NOT on `&`. The pane box in
        // `App.tsx` already paints itself `pane.color`, so `&` needs nothing:
        // measured without it, `.cm-editor` is `rgba(0, 0, 0, 0)` and the box
        // shows through correctly. The gutter is the opposite case, because
        // CodeMirror paints it itself: measured without this line it is
        // `rgb(245, 245, 245)`, a near-white strip down the left of a
        // near-black pane.
        //
        // `{ dark: true }` picks the base theme's `&dark` rules over its
        // `&light` ones, which is a legibility fix and not a naming
        // preference. Measured under `&light`: the caret computes
        // `rgb(0, 0, 0)` on the same near-black pane, so the editor you can
        // type into has a cursor you cannot see, and ⌘F's search panel opens
        // `rgb(245, 245, 245)` with black text. Under `&dark` those are
        // `rgb(255, 255, 255)` and `rgb(51, 51, 56)` with white text.
        EditorView.theme(
          {
            '&': { color: '#d4d4d8', height: '100%' },
            '.cm-content': {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '11px',
            },
            '.cm-gutters': { backgroundColor: color, color: '#3f3f46', border: 'none' },
            // The base theme's own focus ring is `1px dotted #212121`, which
            // this app marks a focused pane differently from (`App.tsx` draws
            // an inset accent ring on the box).
            '&.cm-focused': { outline: 'none' },
          },
          { dark: true },
        ),
      ],
    })
    const created = new EditorView({ state, parent: host.current })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
  }, [text, relPath, color])

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

  // `editor-content` is on the host rather than on anything CodeMirror makes,
  // because CodeMirror owns everything under here and replaces it freely. The
  // testid is the same one the `<pre>` carried and B1's e2e still reads text
  // off it: measured 2026-08-05, `textContent` here is the gutter's line
  // numbers followed by the document, so a `toContainText` on a file's text
  // still passes. Only for a document that fits on screen, though: CodeMirror
  // renders a window rather than the whole file, and a seeded 4000-line file
  // measured 80 lines and 1012 characters in the DOM. Every fixture in this
  // suite is two lines, so nothing asserts past that today.
  return <div data-testid="editor-content" ref={host} className="scroll-thin h-full overflow-auto" />
}
