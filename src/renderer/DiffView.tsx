import { useEffect, useState } from 'react'
import type { DiffSide } from '../shared/ipc'
import type { PaneColor } from '../shared/paneColors'
import { classifyDiffLines, type DiffLineKind } from './lib/diffLines'

const CLASS_FOR_KIND: Record<DiffLineKind, string> = {
  header: 'whitespace-pre text-faint',
  hunk: 'whitespace-pre text-label',
  add: 'whitespace-pre text-ok',
  remove: 'whitespace-pre text-danger',
  context: 'whitespace-pre text-muted',
}

/**
 * One path's unified diff, read-only.
 *
 * Read-only is the whole design: editing is what the editor pane is for, and a
 * diff that could be typed into would need a save path, a dirty flag and a
 * conflict story for nothing.
 *
 * Re-derived on mount rather than persisted, so a pane restored after the file
 * was committed says there is nothing to show instead of drawing a diff that
 * is no longer true.
 */
export function DiffView({
  projectId,
  relPath,
  side,
  paneColor,
}: {
  projectId: string
  relPath: string | null
  side: DiffSide
  /** The pane's own background, or undefined when it has none of its own. */
  paneColor?: PaneColor
}) {
  const [text, setText] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (relPath === null) {
      setLoaded(true)
      return
    }
    setText(null)
    setLoaded(false)
    let live = true
    window.pterm
      .gitDiff(projectId, relPath, side)
      .then((found) => {
        if (!live) return
        setText(found)
        setLoaded(true)
      })
      .catch(() => {
        if (!live) return
        setText(null)
        setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [projectId, relPath, side])

  return (
    <div
      className="scroll-thin h-full w-full overflow-auto font-mono text-[12px]"
      // `var(--color-bg)` for an uncoloured pane rather than a literal: the
      // canvas moves with the theme, and a hex here would leave a diff pane
      // on the shipped palette's ground under every other one.
      style={{ background: paneColor ?? 'var(--color-bg)' }}
    >
      {loaded && (text === null || text.trim() === '') ? (
        <p data-testid="diff-empty" className="p-2 text-faint">
          No changes to show.
        </p>
      ) : null}
      {text && text.trim() !== '' ? (
        <div data-testid="diff-content" className="p-2">
          {classifyDiffLines(text).map(({ line, kind }, index) => (
            <div
              // Index keys: these lines have no identity of their own, the
              // list is replaced wholesale on every read, and nothing in it is
              // reordered or focused.
              key={index}
              className={CLASS_FOR_KIND[kind]}
            >
              {line === '' ? ' ' : line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
