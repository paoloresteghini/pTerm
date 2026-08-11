import type { TabDescriptor } from '../../shared/ipc'

/**
 * How a tab is named wherever the user is asked to pick one: the tab bar, the
 * sidebar, a dead pane's chrome, and the ⌘K palette.
 *
 * Shared rather than repeated, so the palette cannot drift into naming a tab
 * differently from the bar the user is reading it off. A tab the user has
 * named answers with that name; otherwise the slug and a short id are what
 * identify one.
 *
 * An empty title falls back rather than rendering. Empty is how a name is
 * cleared, and the rename handler stores a cleared name as absent rather than
 * as `""`. The store itself keeps any string it is given, though, so a config
 * edited by hand can still carry `title: ""`, and a tab with no label at all
 * cannot be read or aimed at.
 *
 * The id is 16 hex characters (`newSessionId` in `main/tmux/names.ts` is
 * `randomBytes(8).toString('hex')`, and `encodeSessionName` enforces the
 * length); the first six are plenty to tell tabs apart.
 *
 * An editor or diff pane is named for its file, because `slug · id` says
 * nothing about which file you are looking at when several are open at once.
 * The basename is taken by hand rather than with `node:path`: `nodeIntegration`
 * is off for this window (`src/main/index.ts`) and nothing else under
 * `src/renderer/` imports a `node:` builtin, so there is nothing to bundle
 * it against. A trailing separator still leaves a last non-empty segment
 * (`/tmp/demo/` names the tab `demo`), so only a bare `/` yields nothing;
 * that case falls through to the same label a terminal gets rather than to
 * a blank tab.
 *
 * A browser pane is named for its host, INCLUDING the port: `hostOf` uses
 * `URL#host` rather than `#hostname` because two dev servers on localhost
 * are the common case, and a label of `localhost` twice over identifies
 * neither. `about:blank` has an empty host, so a pane with no page yet
 * falls through to the same slug-and-id label a terminal gets, which is
 * correct: there is no page to name it after. Unlike the editor case above,
 * this parses with the web `URL` global rather than by hand: `nodeIntegration`
 * being off is what rules out `node:path` there, and `URL` is a web platform
 * global rather than a node builtin, so that constraint has nothing to say
 * about it.
 */
export function tabLabel(tab: TabDescriptor): string {
  if (tab.title) return tab.title
  if ((tab.type === 'editor' || tab.type === 'diff') && tab.filePath) {
    const name = tab.filePath.split('/').filter(Boolean).pop()
    if (name) return name
  }
  if (tab.type === 'browser' && tab.url) {
    const host = hostOf(tab.url)
    if (host) return host
  }
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}

/** `URL#host` of a string that may not parse as one, `undefined` if it does not. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}
