/**
 * The settings tabs, in the order the strip draws them. Notifications leads
 * because it is the only one of the four a user changes more than once; the
 * other three are one-time installs and a button you press when you wonder.
 * The pane opens on the first entry.
 */
export const SETTINGS_TABS = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'hooks', label: 'Hooks' },
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
