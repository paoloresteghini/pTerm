/**
 * The settings tabs, in the order the strip draws them. The pane opens on the
 * first entry.
 *
 * Appearance leads, and it is the one tab whose section is worth opening onto:
 * choosing a theme applies it to the whole window immediately, and this pane
 * is a dialog over that window, so the tab shows its own effect. Notifications
 * led before it existed, on the reasoning that it was the only one a user
 * returns to; that is still true of Notifications relative to the two below
 * it, which are a one-time install and a button you press when you wonder.
 */
export const SETTINGS_TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shell-history', label: 'Shell history' },
  { id: 'updates', label: 'Updates' },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

/**
 * Where ArrowLeft and ArrowRight move from `index`, wrapping at both ends.
 * Any other key returns `index` unchanged, so the caller can hand this every
 * keydown and treat "no move" as "not mine".
 *
 * A separate function from the component because this is the only part of the
 * strip a unit test can reach: `vitest.config.ts` runs in the node
 * environment, with no DOM to render a button into.
 */
export function nextTabIndex(index: number, key: string, count: number): number {
  if (count <= 0) return index
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  return index
}
