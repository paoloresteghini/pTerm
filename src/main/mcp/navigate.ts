import { normaliseUrl } from '../../shared/browserUrl'
import { isLoopbackUrl } from '../../shared/localOrigin'
import type { McpRequest } from './protocol'
import { browserPaneFor, type RouteConfig } from './route'

/**
 * The one tool this app's MCP server offers. Named here rather than spelled
 * as a literal in the two places that need it (this module, which refuses
 * anything else, and `bridge.ts`, which advertises it), so the wire name and
 * the implemented name cannot drift apart.
 */
export const BROWSER_NAVIGATE = 'browser_navigate'

/**
 * What a `browser_navigate` request comes to: a refusal, a pane to navigate,
 * or a pane to create first.
 *
 * `url` rides along on both success shapes because the caller navigates
 * AFTER creating, never by creating: see the create branch's own note in
 * `registerIpc`, and requirement 3 of this task.
 */
export type NavigatePlan =
  | { error: string }
  | { paneId: string; url: string }
  | { create: { projectSlug: string; cwd: string }; url: string }

/**
 * Whether a browser pane showing `url` is somewhere an agent may be handed
 * control of.
 *
 * `about:blank` is where every pane this app creates for an agent starts, and
 * a row with no `url` at all (a hand-edited config, see `TabDescriptor.url`)
 * renders as `about:blank` too, so both are as good as blank. The empty
 * string is the third spelling of the same thing: it is what a guest's
 * `getURL()` answers before it has loaded anything. Anything else has to be
 * loopback.
 *
 * Two callers, deliberately, and they ask about different values.
 * `planBrowserNavigate` below asks about the pane's REMEMBERED url, so a call
 * is refused before anything is created or navigated; `registerIpc`'s handler
 * asks about `guest.getURL()` once the guest is in hand, which is the
 * authoritative answer, since the remembered one arrives by `did-navigate`
 * and a debounced `setPaneUrl` and therefore lags the page.
 */
export function isSafeToDrive(url: string | undefined): boolean {
  if (url === undefined || url === '' || url === 'about:blank') return true
  return isLoopbackUrl(url)
}

/**
 * Decide what one `browser_navigate` request should do, without doing any of
 * it.
 *
 * Pure, and separate from `registerIpc` for the reason `releaseAgentSession`
 * is: this is where the confinement decisions live, and they are worth
 * testing without an Electron host near them.
 *
 * Three refusals, in order, and each one is a boundary rather than a nicety:
 *
 * 1. **The tool name.** Anything but `browser_navigate` is refused here as
 *    well as being absent from the bridge's `tools/list`, because the bridge
 *    is a script on the user's disk and this socket is the app's own boundary.
 *    Back, forward and reload are deliberately not in this plan's surface.
 * 2. **The URL argument.** `loadURL` called from main emits no
 *    `will-navigate`, `will-redirect` or `will-frame-navigate` (Electron's own
 *    typings say so of programmatic navigation), so every mechanism Task 7
 *    shipped is blind to a tool's argument. This check is the whole of the
 *    confinement for the one navigation an agent asks for by name.
 * 3. **Where the pane already is.** See `isSafeToDrive`. Read off the pane
 *    row, which is config's memory of where the page settled and lags it, so
 *    the handler asks the guest itself the same question again before it
 *    navigates. This one is here so that a refusal costs nothing and happens
 *    before any side effect; that one is here because it is authoritative.
 *
 * The URL is normalised the way the address bar normalises what a user types
 * (`normaliseUrl`), so `localhost:5173` is http and a bare `example.com` is
 * https and therefore refused. Normalisation can only ever move a host from
 * no scheme to one; it cannot turn a non-loopback host into a loopback one.
 */
export function planBrowserNavigate(config: RouteConfig, request: McpRequest): NavigatePlan {
  if (request.tool !== BROWSER_NAVIGATE) {
    return { error: `pTerm has no tool called ${request.tool}` }
  }

  const raw = request.args.url
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: `${BROWSER_NAVIGATE} needs a "url" argument, as a string` }
  }

  const url = normaliseUrl(raw)
  if (url === null || !isLoopbackUrl(url)) {
    return {
      error:
        `refusing to open ${raw}: a pTerm browser pane driven by an agent is confined to ` +
        'loopback origins (localhost, 127.0.0.1, [::1] or a .localhost subdomain, on http or https)',
    }
  }

  const route = browserPaneFor(config, request.paneId)
  if ('error' in route) return { error: route.error }
  if ('create' in route) return { create: route.create, url }

  const existing = config.panes.find((pane) => pane.id === route.paneId)
  if (!isSafeToDrive(existing?.url)) {
    return {
      error:
        `refusing to drive browser pane ${route.paneId}: it is on ${existing?.url ?? ''}, ` +
        'which is not a loopback origin',
    }
  }
  return { paneId: route.paneId, url }
}
