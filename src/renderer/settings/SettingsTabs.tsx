import { useRef } from 'react'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { nextTabIndex, SETTINGS_TABS, type SettingsTabId } from './tabs'

/**
 * The settings navigation, rendered with the same shadcn tabs primitive as
 * the workspace. The parent owns its value and its content panel, which keeps
 * this component focused on the tab list itself.
 */
export function SettingsTabs({
  onValueChange,
}: {
  onValueChange: (value: SettingsTabId) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  return (
    <TabsList
      variant="line"
      aria-label="Settings sections"
      className="h-9 w-full justify-start gap-1 overflow-x-auto rounded-none p-0"
    >
      {SETTINGS_TABS.map((tab, index) => (
        <TabsTrigger
          key={tab.id}
          data-testid={`settings-tab-${tab.id}`}
          ref={(button) => {
            buttons.current[index] = button
          }}
          value={tab.id}
          className="h-9 flex-none cursor-default rounded-none px-3 text-xs data-[state=active]:bg-transparent"
          onKeyDown={(event) => {
            const nextIndex = nextTabIndex(index, event.key, SETTINGS_TABS.length)
            if (nextIndex === index) return

            event.preventDefault()
            onValueChange(SETTINGS_TABS[nextIndex].id)
            buttons.current[nextIndex]?.focus()
          }}
        >
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  )
}
