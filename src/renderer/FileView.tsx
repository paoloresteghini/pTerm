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
    // Cleared before the fetch, not left from the previous path: nothing in
    // this slice ever changes a pane's file, but a component that answers for
    // the file it was last asked about is not a thing to leave lying around
    // for the slice that does.
    setMissing(false)
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
      <div data-testid="editor-missing" className="p-3 font-mono text-[11px] text-faint">
        That file is no longer there.
      </div>
    )
  }

  return (
    <pre
      data-testid="editor-content"
      className="scroll-thin h-full overflow-auto p-3 font-mono text-[11px] leading-relaxed"
    >
      {text ?? ''}
    </pre>
  )
}
