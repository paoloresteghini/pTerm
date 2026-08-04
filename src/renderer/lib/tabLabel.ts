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
 * An editor pane is named for its file, because `slug · id` says nothing
 * about which file you are looking at when several are open at once. The
 * basename is taken by hand rather than with `node:path`: `nodeIntegration`
 * is off for this window (`src/main/index.ts`) and nothing else under
 * `src/renderer/` imports a `node:` builtin, so there is nothing to bundle
 * it against. A trailing separator or a bare `/` yields nothing, which
 * falls through to the same label a terminal gets rather than to a blank
 * tab.
 */
export function tabLabel(tab: TabDescriptor): string {
  if (tab.title) return tab.title
  if (tab.type === 'editor' && tab.filePath) {
    const name = tab.filePath.split('/').filter(Boolean).pop()
    if (name) return name
  }
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}
