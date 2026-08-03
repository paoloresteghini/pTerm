import type { TabDescriptor } from '../../shared/ipc'

/**
 * How a tab is named wherever the user is asked to pick one: the tab bar, a
 * dead pane's chrome, and the ⌘K palette.
 *
 * Shared rather than repeated, so the palette cannot drift into naming a tab
 * differently from the bar the user is reading it off. There is no title field
 * on a tab; the slug and a short id are what identify one.
 *
 * The id is 16 hex characters (`newSessionId` in `main/tmux/names.ts` is
 * `randomBytes(8).toString('hex')`, and `encodeSessionName` enforces the
 * length); the first six are plenty to tell tabs apart.
 */
export function tabLabel(tab: TabDescriptor): string {
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}
