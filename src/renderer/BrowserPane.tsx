import { useEffect, useRef, useState } from 'react'
import type {
  DidFailLoadEvent,
  DidNavigateEvent,
  DidNavigateInPageEvent,
  RenderProcessGoneEvent,
} from 'electron'
import { Button } from './ui/Button'
import { normaliseUrl } from '../shared/browserUrl'
import { UNSORTED_ID } from '../shared/ipc'
import type { PaneColor } from '../shared/paneColors'
import { createUrlSync } from './lib/urlSync'

/**
 * `@types/react` already declares `<webview>` as a JSX intrinsic element, but
 * its ref type, `HTMLWebViewElement`, is an EMPTY interface (the definition
 * dates from Chrome Apps, not Electron), so it carries none of `goBack`,
 * `loadURL`, `canGoForward` or anything else this pane calls.
 *
 * Declaration-merging Electron's whole `WebviewTag` in does not work here:
 * `WebviewTag` itself extends `HTMLElement` and redeclares
 * `addEventListener`/`removeEventListener` with narrower, webview-specific
 * signatures, and a merged interface cannot extend two bases whose versions
 * of the same member disagree (measured: tsc rejects it, "Interface
 * 'HTMLWebViewElement' cannot simultaneously extend types 'HTMLElement' and
 * 'WebviewTag'"). Declaring `addEventListener` directly on the merge instead
 * of through `extends` runs into the same conflict one level down: the
 * merged interface still has to satisfy the `extends HTMLElement` React's
 * own declaration already carries, and a narrower `addEventListener`
 * overload does not (measured: "Interface 'HTMLWebViewElement' incorrectly
 * extends interface 'HTMLElement'").
 *
 * So this adds only the navigation methods, which HTMLElement has no member
 * of that name to conflict with, and leaves `addEventListener` alone: the
 * effect below casts its own listeners to the DOM's generic `EventListener`
 * at the point they are registered, rather than fight the merge for a type
 * only two call sites need.
 *
 * Declared here, next to the only place in the app that renders a
 * `<webview>`, rather than in a global `.d.ts` nothing else would have a
 * reason to open.
 */
declare global {
  interface HTMLWebViewElement {
    goBack(): void
    goForward(): void
    reload(): void
    loadURL(url: string): Promise<void>
    canGoBack(): boolean
    canGoForward(): boolean
    openDevTools(): void
    closeDevTools(): void
    isDevToolsOpened(): boolean
  }
}

/**
 * The `partition` a browser pane's `<webview>` loads under: the boundary
 * that keeps one project's cookies and storage away from another's, and away
 * from the app's own default session, which is what an unpartitioned webview
 * would otherwise share.
 *
 * `projectIdForTab` (`App.tsx`) answers `UNSORTED_ID` for a pane whose owning
 * project no longer resolves (a project that was removed while one of its
 * browser panes was still open). That id is synthetic, backed by no project
 * row, so folding it into `persist:proj-${projectId}` unchanged would name a
 * session after a project that does not exist. This names that case
 * explicitly instead: one fixed partition every such pane shares, the same
 * way two panes of one real project already share theirs.
 */
export function partitionFor(projectId: string): string {
  return projectId === UNSORTED_ID ? 'persist:proj-unsorted' : `persist:proj-${projectId}`
}

/**
 * Whether a `did-fail-load` errorCode names a page that actually failed, as
 * opposed to Chromium's -3 (ABORTED), which fires on an ordinary redirect
 * and on a load a newer navigation cancelled before it finished. A naive
 * handler that treats every `did-fail-load` as a failure flashes an error
 * card over a perfectly healthy page every time either of those happens.
 *
 * -3 is the only code excluded here, on purpose: it is the single exclusion
 * this pane's brief names, and a wider guess at "probably also benign"
 * codes would risk swallowing a real failure that happens to share -3's
 * shape without sharing its cause.
 *
 * Exported so this one rule is testable without mounting a `<webview>`:
 * `tests/unit/browserFailure.test.ts` drives it directly, since
 * `vitest.config.mts` runs with no DOM to mount one against (see the
 * comment atop `urlSync.ts`).
 */
export function isRealLoadFailure(errorCode: number): boolean {
  return errorCode !== -3
}

/**
 * One page, in a hardened `<webview>`.
 *
 * The chrome strip above it (back, forward, reload, a typed address) lives
 * INSIDE this pane's own box, not beside it: `tests/e2e/splits.spec.ts`
 * encodes the flex row's whole pixel budget, and nothing here is meant to be
 * always-on chrome the way the tab bar or the title bar is.
 *
 * `url` is read only once, into `address`, which becomes the `<webview>`'s
 * initial `src` and nothing else. Every navigation after that, whether it is
 * back, forward, reload, a typed address or a link clicked inside the page,
 * goes through the element's own imperative API rather than through React
 * state, because writing `src` again would hand the page a fresh navigation
 * to whatever it already happens to be showing. Where the user navigates to
 * IS saved, just not through `address`: the effect below reports it to main
 * off `did-navigate`/`did-navigate-in-page`, debounced, so a relaunch
 * reopens this pane wherever navigation last settled rather than at the
 * `url` it was originally opened with.
 */
export function BrowserPane({
  paneId,
  projectId,
  url,
  paneColor,
}: {
  paneId: string
  projectId: string
  url: string | undefined
  /** The pane's own background, or undefined when it has none of its own. */
  paneColor: PaneColor | undefined
}) {
  const view = useRef<HTMLWebViewElement | null>(null)
  const [address] = useState(url ?? 'about:blank')
  const [typed, setTyped] = useState(address)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  // Mirrors `isDevToolsOpened()`, kept in step by the `devtools-opened`/
  // `devtools-closed` listeners below rather than read fresh on every
  // render: those fire whether the DevTools window closed through this
  // pane's own button or the user closing it directly, so this stays
  // accurate either way. The button's click handler still asks
  // `isDevToolsOpened()` directly rather than trusting this state, so a
  // toggle can never fire in the wrong direction on the one render where
  // the two might disagree.
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  // The two failure states this pane shows: `did-fail-load` (when
  // `isRealLoadFailure` says so) and `render-process-gone`. Both render a
  // card over the webview rather than closing the pane or its tab: a
  // browser pane cannot die the way a terminal can, and `canHaveSession` is
  // false for it, so the `DeadPane` path this app uses for a crashed
  // terminal does not apply here. Mutually exclusive in practice (a crashed
  // renderer does not also fail a load), but kept as two independent
  // optionals rather than one shared enum: neither ever needs a value
  // meaning "both", so an enum would only add a name for a case that
  // cannot happen.
  const [loadFailure, setLoadFailure] = useState<{
    errorCode: number
    errorDescription: string
  } | null>(null)
  // Electron's `reason` ('crashed', 'killed', 'oom', ...), or null when the
  // renderer has not gone. Carrying the reason rather than a plain boolean
  // is what lets the card say what happened instead of just that something
  // did, the same distinction `loadFailure` draws by carrying the error
  // code and description rather than a bare flag.
  const [crashed, setCrashed] = useState<string | null>(null)
  // One instance for the pane's lifetime, the same way `NotesPanel` holds
  // its `noteSaver`: `urlSync.ts` owns the debounce, so this component only
  // schedules and cancels. `window.pterm.setPaneUrl` already matches
  // `createUrlSync`'s `send` signature, so no wrapper closure is needed.
  const urlSync = useRef(createUrlSync(window.pterm.setPaneUrl)).current

  /**
   * Keeps the back/forward buttons and the address bar in step with the
   * webview's own history, including navigation this pane's own buttons had
   * no part in: a link clicked inside the page, or a redirect. Also the only
   * place this pane's current page reaches main: `urlSync.schedule` debounces,
   * so a page that redirects several times on one navigation (an auth bounce,
   * a dev server's reconnect) writes `config.json` once, on settle, rather
   * than once per hop for no benefit, the same way `setLayout` commits a
   * drag on pointer-up rather than on every frame.
   *
   * Registered once, on mount, rather than depending on anything: the
   * `<webview>` element itself is never replaced for the life of this pane
   * (it is not conditionally rendered, and `partition`/`src` are only ever
   * set at mount), so there is nothing here that would need the listeners
   * re-attached.
   */
  useEffect(() => {
    const node = view.current
    if (!node) return
    const sync = (nextUrl: string) => {
      setCanGoBack(node.canGoBack())
      setCanGoForward(node.canGoForward())
      setTyped(nextUrl)
      urlSync.schedule(paneId, nextUrl)
    }
    const onNavigate = (event: Event) => sync((event as DidNavigateEvent).url)
    // `did-navigate-in-page` also fires for a subframe's own in-page
    // navigation (an embedded iframe changing its hash); `isMainFrame` is
    // what keeps that from overwriting the address bar with a URL the top of
    // the page never went to.
    const onNavigateInPage = (event: Event) => {
      const withFrame = event as DidNavigateInPageEvent
      if (withFrame.isMainFrame) sync(withFrame.url)
    }
    // A subframe (an ad, an embed) can fail to load on an otherwise healthy
    // page; `isMainFrame` is what keeps that from covering the whole pane in
    // a card over content that rendered fine. `isRealLoadFailure` is the
    // other half of the gate: without it, this would also fire on -3
    // (ABORTED), which an ordinary redirect or a newer navigation produces
    // on a page nothing is wrong with.
    const onFailLoad = (event: Event) => {
      const withDetail = event as DidFailLoadEvent
      if (!withDetail.isMainFrame) return
      if (!isRealLoadFailure(withDetail.errorCode)) return
      setCrashed(null)
      setLoadFailure({
        errorCode: withDetail.errorCode,
        errorDescription: withDetail.errorDescription,
      })
    }
    // The renderer behind this `<webview>` is gone (crashed, killed, ran out
    // of memory); the pane and its tab survive regardless of `reason`; the
    // card just names it.
    const onRenderProcessGone = (event: Event) => {
      const withDetails = event as RenderProcessGoneEvent
      setLoadFailure(null)
      setCrashed(withDetails.details.reason)
    }
    // Fires at the start of every navigation, including the one a Retry or
    // Reload button triggers, and including one the user starts some other
    // way (back, forward, a typed address) after a failure. Either way, a
    // card describing the LAST attempt has no business surviving into this
    // one: clearing here, rather than only on success, means a second
    // failure of a different kind replaces the card instead of leaving the
    // first one's text under it.
    const onStartLoading = () => {
      setLoadFailure(null)
      setCrashed(null)
    }
    const onDevToolsOpened = () => setDevToolsOpen(true)
    const onDevToolsClosed = () => setDevToolsOpen(false)
    node.addEventListener('did-navigate', onNavigate)
    node.addEventListener('did-navigate-in-page', onNavigateInPage)
    node.addEventListener('did-fail-load', onFailLoad)
    node.addEventListener('render-process-gone', onRenderProcessGone)
    node.addEventListener('did-start-loading', onStartLoading)
    node.addEventListener('devtools-opened', onDevToolsOpened)
    node.addEventListener('devtools-closed', onDevToolsClosed)
    return () => {
      node.removeEventListener('did-navigate', onNavigate)
      node.removeEventListener('did-navigate-in-page', onNavigateInPage)
      node.removeEventListener('did-fail-load', onFailLoad)
      node.removeEventListener('render-process-gone', onRenderProcessGone)
      node.removeEventListener('did-start-loading', onStartLoading)
      node.removeEventListener('devtools-opened', onDevToolsOpened)
      node.removeEventListener('devtools-closed', onDevToolsClosed)
      // Without this, a pane closed while a debounce is pending would still
      // fire its write after unmount: nothing here awaits it, and `urlSync`
      // does not know its pane is gone.
      urlSync.cancel()
    }
  }, [])

  return (
    <div
      className="flex h-full flex-col"
      data-testid={`browserpane-${paneId}`}
      // `var(--color-bg)` for an uncoloured pane rather than a literal, the
      // same fallback and the same reasoning `DiffView.tsx` uses: the canvas
      // has to move with the theme rather than pin to one palette's hex.
      style={{ background: paneColor ?? 'var(--color-bg)' }}
    >
      <div className="flex items-center gap-1 border-b border-border bg-surface p-1 text-[11px]">
        <Button
          data-testid={`browserback-${paneId}`}
          aria-label="Back"
          size="icon"
          variant="ghost"
          disabled={!canGoBack}
          onClick={() => view.current?.goBack()}
        >
          ←
        </Button>
        <Button
          data-testid={`browserforward-${paneId}`}
          aria-label="Forward"
          size="icon"
          variant="ghost"
          disabled={!canGoForward}
          onClick={() => view.current?.goForward()}
        >
          →
        </Button>
        <Button
          data-testid={`browserreload-${paneId}`}
          aria-label="Reload"
          size="icon"
          variant="ghost"
          onClick={() => view.current?.reload()}
        >
          ↻
        </Button>
        <input
          data-testid={`browserurl-${paneId}`}
          // Same reason every other text field in this app carries it:
          // without it, a ⌘ combo typed while addressing the bar (⌘A to
          // select the text, ⌘W to close the pane) reaches App.tsx's
          // window-level shortcut handler instead of the field.
          data-shortcuts="off"
          aria-label="Address"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const next = normaliseUrl(typed)
            if (next) view.current?.loadURL(next)
          }}
          spellCheck={false}
          className="min-w-0 flex-1 border border-border bg-raised px-1 text-fg outline-none"
        />
        <Button
          data-testid={`browserdevtools-${paneId}`}
          aria-label="Toggle DevTools"
          aria-pressed={devToolsOpen}
          size="icon"
          // `default` rather than `ghost` while open: the same on/off
          // distinction `Button.tsx`'s two variants already draw, reused
          // here as the toggle's only visual state rather than adding a
          // third variant this is the sole caller of.
          variant={devToolsOpen ? 'default' : 'ghost'}
          onClick={() => {
            const node = view.current
            if (!node) return
            // Asks the webview directly rather than trusting `devToolsOpen`:
            // that state updates off the `devtools-opened`/`devtools-closed`
            // listeners above, which is accurate a moment after either one
            // fires but is one render behind `isDevToolsOpened()` on the
            // render where the click itself happens.
            if (node.isDevToolsOpened()) node.closeDevTools()
            else node.openDevTools()
          }}
        >
          🛠
        </Button>
      </div>
      {/* `relative` so the failure cards below can cover the webview without
          taking any layout space of their own, the same reasoning
          `DeadPane.tsx` gives for its own absolute strip. */}
      <div className="relative min-h-0 flex-1">
        <webview
          ref={view}
          src={address}
          partition={partitionFor(projectId)}
          className="h-full w-full"
          data-testid={`browserview-${paneId}`}
        />
        {loadFailure && (
          <div
            data-testid={`browsererror-${paneId}`}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface p-4 text-center font-mono text-[11px] text-fg"
          >
            <div className="text-muted">Failed to load ({loadFailure.errorCode})</div>
            <div>{loadFailure.errorDescription}</div>
            <Button
              data-testid={`browsererrorretry-${paneId}`}
              onClick={() => view.current?.reload()}
            >
              Retry
            </Button>
          </div>
        )}
        {crashed !== null && (
          <div
            data-testid={`browsercrashed-${paneId}`}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface p-4 text-center font-mono text-[11px] text-fg"
          >
            <div className="text-muted">This page's renderer is gone ({crashed})</div>
            <Button
              data-testid={`browsercrashedreload-${paneId}`}
              onClick={() => view.current?.reload()}
            >
              Reload
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
