import { useEffect, useState } from 'react'

/**
 * One file, read-only.
 *
 * A `<pre>` rather than an editor: CodeMirror is slice B2, and this slice is
 * the pane model and the restore path. What is here has to be real content
 * rather than a placeholder, because the relaunch test's whole value is
 * asserting a file's text came back.
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
 */
export function FileView({ projectId, relPath }: { projectId: string; relPath: string | null }) {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

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
    <pre
      data-testid="editor-content"
      // `text-term-fg` because an editor pane sits in the same pane row as the
      // terminals, in the same window, showing the same kind of monospace
      // content, so it should read as the same surface: #d4d4d8 is literally
      // what xterm is given as its foreground (`Terminal.tsx`, which repeats
      // the value by hand because a canvas cannot read a CSS variable).
      //
      // A colour here at all, rather than an inherited one, is the point.
      // Measured 2026-08-04 with no class: `getComputedStyle(pre).color` was
      // `rgb(0, 0, 0)` over a `rgb(9, 9, 11)` pane, about 1.06:1, which is not
      // dim text but invisible text. Nothing between this element and `<html>`
      // sets `color`, so it was falling all the way back to the initial value.
      // `text-term-fg` measures 13.5:1 against that background; `text-fg`
      // (#fafafa) would be 19.1:1 and is the app's CHROME colour, used for tab
      // labels and the like, which file contents are not.
      //
      // Matching the terminal also settles the recoloured case for free, which
      // picking any other light grey would not: `PANE_COLORS` were chosen
      // against this exact foreground and its own doc records the worst of the
      // six at 7.89:1, so a right-clicked editor pane is covered by a ratio
      // somebody already worked out.
      //
      // `editor-missing` above deliberately stays `text-faint`: a message about
      // an absent file is secondary text, and it is right as it is.
      className="scroll-thin h-full overflow-auto p-3 font-mono text-[11px] leading-relaxed text-term-fg"
    >
      {text ?? ''}
    </pre>
  )
}
