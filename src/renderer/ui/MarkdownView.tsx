import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxColorStyle } from '../lib/syntaxColors'

/**
 * The theme markdown source is painted with here.
 *
 * `FileView.tsx`'s `themeFor` sits in a `Compartment` and fixes `&`'s height
 * to `100%` because it fills a pane whose own box supplies the scrolling.
 * Nothing here needs recolouring after it mounts (an issue body never
 * changes pane colour), so a compartment buys nothing, and the height stays
 * unset on purpose: CodeMirror sizes `&` to its document by default, and
 * that is what lets a short comment sit as a few lines while a long issue
 * body pushes the modal's own scroll container, rather than opening a second
 * scrollbar nested inside the first.
 */
const theme = EditorView.theme(
  {
    '&': { color: '#d4d4d8', backgroundColor: 'transparent' },
    '.cm-content': { padding: 0 },
    '.cm-scroller': {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, 'pTerm Symbols', monospace",
      fontSize: '11px',
      lineHeight: '1.6',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
)

/**
 * Read-only markdown SOURCE, syntax highlighted, never rendered to HTML.
 *
 * An issue or comment body is text an arbitrary GitHub user wrote, and
 * GitHub markdown permits raw HTML inside it. This component shows the text
 * of that body, coloured by CodeMirror's markdown grammar the same way a
 * `.md` file in `FileView.tsx` is, and nothing here ever turns the string
 * into DOM: no markdown-to-HTML step, no `dangerouslySetInnerHTML`. A reader
 * who wants the rendered version has the `↗ Open on GitHub` link one click
 * away, where GitHub's own sanitiser is the one taking the risk.
 *
 * `EditorView.editable.of(false)` keeps the document out of the tab order
 * and off the keyboard; `EditorState.readOnly.of(true)` blocks it from a
 * stray dispatch too, since the two guard different paths and this view has
 * no legitimate writer on either one.
 */
export function MarkdownView({ value, className }: { value: string; className?: string }) {
  const host = useRef<HTMLDivElement | null>(null)

  // Rebuilt whenever `value` changes rather than reconfigured in place: this
  // view is handed a whole new body each time (a different issue, a
  // different comment), never edited in place the way `FileView.tsx`'s
  // document is, so there is no cursor or scroll position worth preserving
  // across a change.
  useEffect(() => {
    if (host.current === null) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        EditorView.lineWrapping,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        syntaxHighlighting(syntaxColorStyle, { fallback: true }),
        markdown(),
        theme,
      ],
    })
    const view = new EditorView({ state, parent: host.current })
    return () => view.destroy()
  }, [value])

  return <div data-testid="markdown-view" ref={host} className={className} />
}
