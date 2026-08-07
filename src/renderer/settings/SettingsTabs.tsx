import { useRef } from 'react'
import { cn } from '../lib/cn'
import { SETTINGS_TABS, nextTabIndex, type SettingsTabId } from './tabs'

/**
 * The settings pane's line tabs.
 *
 * Hand-rolled rather than Radix: `@radix-ui/react-tabs` is not a dependency
 * of this project and this is 40 lines. The arrow-key handling below is
 * therefore ours, written out, not a capability assumed from a library.
 *
 * Inactive tabs are drawn in `text-label`, not `--color-faint`, which
 * measures 1.86:1 on `--color-surface`. See `tests/unit/labelContrast.test.ts`.
 */
export function SettingsTabs({
  active,
  onSelect,
}: {
  active: SettingsTabId
  onSelect: (id: SettingsTabId) => void
}) {
  // Keyed by tab id so an arrow key can move focus to the tab it selects.
  // Without this the roving tabIndex moves but the focus ring does not.
  const buttons = useRef<Partial<Record<SettingsTabId, HTMLButtonElement | null>>>({})
  const index = SETTINGS_TABS.findIndex((tab) => tab.id === active)

  return (
    <div role="tablist" aria-label="Settings sections" className="mb-3 flex gap-4 border-b border-border">
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(node) => {
            buttons.current[tab.id] = node
          }}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          aria-selected={tab.id === active}
          // Only one panel is ever in the DOM (see SettingsPane.tsx), so an
          // inactive tab has no element to point at; a dangling IDREF there
          // is worse than none.
          aria-controls={tab.id === active ? `settings-panel-${tab.id}` : undefined}
          data-testid={`settings-tab-${tab.id}`}
          // Roving tabIndex: one stop for the whole strip, arrows move within
          // it. That is what a tablist is expected to do, and it keeps Tab
          // from walking four buttons before reaching the section.
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            const next = nextTabIndex(index, event.key, SETTINGS_TABS.length)
            if (next === index) return
            event.preventDefault()
            const target = SETTINGS_TABS[next]
            onSelect(target.id)
            buttons.current[target.id]?.focus()
          }}
          className={cn(
            '-mb-px cursor-default border-b px-0.5 pb-1.5 text-[11px] uppercase tracking-wider',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            tab.id === active
              ? 'border-fg text-fg'
              : 'border-transparent text-label hover:text-fg',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
