import { useEffect, useState } from 'react'
import type { DiffSide } from '../shared/ipc'
import { PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'

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
  color = PANE_COLOR_DEFAULT,
}: {
  projectId: string
  relPath: string | null
  side: DiffSide
  color?: PaneColor
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
      style={{ background: color }}
    >
      {loaded && (text === null || text.trim() === '') ? (
        <p data-testid="diff-empty" className="p-2 text-faint">
          No changes to show.
        </p>
      ) : null}
      {text && text.trim() !== '' ? (
        <div data-testid="diff-content" className="p-2">
          {text.split('\n').map((line, index) => (
            <div
              // Index keys: these lines have no identity of their own, the
              // list is replaced wholesale on every read, and nothing in it is
              // reordered or focused.
              key={index}
              className={
                line.startsWith('+++') || line.startsWith('---')
                  ? 'whitespace-pre text-faint'
                  : line.startsWith('@@')
                    ? 'whitespace-pre text-label'
                    : line.startsWith('+')
                      ? 'whitespace-pre text-ok'
                      : line.startsWith('-')
                        ? 'whitespace-pre text-danger'
                        : 'whitespace-pre text-muted'
              }
            >
              {line === '' ? ' ' : line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
