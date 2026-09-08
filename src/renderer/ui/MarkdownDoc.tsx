import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ThemeId } from '../../shared/themes'
import type { PaneColor } from '../../shared/paneColors'
import { xtermTheme } from '../lib/xtermTheme'
import { externalHref, renderableImageSrc } from '../lib/markdownLinks'

/**
 * One markdown document, rendered.
 *
 * **No raw HTML reaches the DOM from here, and that is a property of the
 * pipeline rather than of a filter.** `react-markdown` builds React elements
 * and never assigns `innerHTML`; the plugin that would change that,
 * `rehype-raw`, is deliberately absent, so a `<script>` or an `<img onerror>`
 * written into a `.md` arrives as visible text. There is no sanitiser here
 * because there is nothing for one to sanitise: nothing in this path can turn
 * a string into markup.
 *
 * That matters more than it looks. The files this renders are whatever is in
 * the user's project directory, which for a cloned repository is text a
 * stranger wrote, and it renders inside the pTerm renderer, where
 * `window.pterm` is one global away.
 *
 * `ui/MarkdownView.tsx` is the deliberate opposite of this component and both
 * are correct: that one shows GitHub issue and comment bodies, which are
 * arbitrary strangers' text with a rendered version one click away on
 * github.com, so it paints the SOURCE and never renders. This one is for
 * files the user chose to open from their own tree, where a rendered view is
 * the whole point of the pane.
 */
export function MarkdownDoc({
  source,
  theme,
  paneColor,
}: {
  source: string
  /** The palette in force. Supplies the ink when the pane has no colour. */
  theme: ThemeId
  /** The pane's own background, or undefined when it has none of its own. */
  paneColor?: PaneColor
}) {
  // The same call `FileView`'s `themeFor` makes for the editor, so the
  // rendered view and the source view of one file are the same ink on the
  // same ground and switching between them does not change colour. Only the
  // foreground is used: the pane box in `App.tsx` already paints the
  // background.
  const { foreground } = xtermTheme(theme, paneColor)
  return (
    <div data-testid="markdown-doc" className="markdown-doc" style={{ color: foreground }}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          /**
           * Every link is cancelled and re-routed, including the ones that go
           * nowhere.
           *
           * `preventDefault` runs before the href is even examined. An anchor
           * left to act on its own would not open a tab: this document is the
           * renderer, so following a link REPLACES the running app with the
           * target page, `window.pterm` and every open pane with it. There is
           * no back button to come home by.
           *
           * `externalHref` returning null is a dead click on purpose. That
           * covers `javascript:` and `file:` (dangerous) and equally
           * `./other.md` (harmless but unresolvable: this pane is handed a
           * string, not a location, so there is nothing to resolve a relative
           * path against). Both end the same way, because a link that cannot
           * be honoured correctly should do nothing rather than something
           * approximate.
           */
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault()
                const target = externalHref(href)
                if (target !== null) void window.pterm.openExternal(target)
              }}
            >
              {children}
            </a>
          ),
          /**
           * An image whose source this cannot fetch shows its alt text.
           *
           * A relative `src` is the common case in a README and the one that
           * cannot work: the renderer's origin is the app bundle, so
           * `docs/x.png` resolves against that and Chromium paints its
           * broken-image glyph. The author's own alt text says more than the
           * glyph does.
           */
          img: ({ src, alt }) => {
            const usable = renderableImageSrc(typeof src === 'string' ? src : undefined)
            return usable === null ? <span>{alt}</span> : <img src={usable} alt={alt} />
          },
          /**
           * A table scrolls inside its own box.
           *
           * Without the wrapper a wide table sizes the document, which puts a
           * horizontal scrollbar under the whole pane and drags every
           * paragraph sideways when the table is what needed to move.
           */
          table: ({ children }) => (
            <div className="md-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  )
}
