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
 */
export function tabLabel(tab: TabDescriptor): string {
  return tab.title ? tab.title : `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}
