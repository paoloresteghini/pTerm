import { useEffect, useState } from 'react'
import type { NotificationConfig } from '../../shared/ipc'
import type { ThemeId } from '../../shared/themes'
import type { FontChoice } from '../fonts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { SettingsTabs } from './SettingsTabs'
import { SETTINGS_TABS, type SettingsTabId } from './tabs'
import { AppearanceSection } from './AppearanceSection'
import { ShellHistorySection } from './ShellHistorySection'
import { NotificationsSection } from './NotificationsSection'
import { UpdatesSection } from './UpdatesSection'

export function SettingsPane({
  open,
  onOpenChange,
  notifications,
  onNotificationsChange,
  theme,
  onThemeChange,
  editorFont,
  onEditorFontChange,
  terminalFont,
  onTerminalFontChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
  /** The palette in force, so the picker can mark the chosen card. */
  theme: ThemeId
  onThemeChange: (id: ThemeId) => void
  editorFont: FontChoice
  onEditorFontChange: (font: FontChoice) => void
  terminalFont: FontChoice
  onTerminalFontChange: (font: FontChoice) => void
}) {
  const [tab, setTab] = useState<SettingsTabId>(SETTINGS_TABS[0].id)
  const [version, setVersion] = useState<string | null>(null)

  // The version is decoration next to a dialog that already works, so a failed
  // read leaves the ellipsis in place rather than needing a place to show an
  // error. Unlike the sections' reads, it cannot change while the app runs, so
  // it is read once for the life of the window rather than on each open.
  useEffect(() => {
    window.pterm
      .appVersion()
      .then(setVersion)
      .catch(() => undefined)
  }, [])

  // The pane opens on the first tab every time. This component stays mounted
  // for the life of the window, so without this the tab you last looked at is
  // the tab you get, which is a preference nobody asked for and one more thing
  // to be wrong about.
  useEffect(() => {
    if (open) setTab(SETTINGS_TABS[0].id)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="settings-pane"
        className="flex max-h-[85vh] w-[min(720px,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 font-sans sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-12 text-left">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Personalize pTerm and manage its integrations.</DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as SettingsTabId)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 border-b border-border px-4 py-2">
            <SettingsTabs onValueChange={setTab} />
          </div>
          {/* Only the selected section is mounted. Shell history and Updates
              each read their own file on mount, so selecting one of those tabs
              gives it a fresh read. Notifications takes its data as a prop
              instead, fetched once at app startup. */}
          <TabsContent value={tab} className="scroll-thin m-0 min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {tab === 'appearance' ? (
            <AppearanceSection
              theme={theme}
              onThemeChange={onThemeChange}
              editorFont={editorFont}
              onEditorFontChange={onEditorFontChange}
              terminalFont={terminalFont}
              onTerminalFontChange={onTerminalFontChange}
            />
          ) : null}
          {tab === 'notifications' ? (
            <NotificationsSection
              notifications={notifications}
              onNotificationsChange={onNotificationsChange}
            />
          ) : null}
          {tab === 'shell-history' ? <ShellHistorySection /> : null}
          {tab === 'updates' ? <UpdatesSection /> : null}
          </TabsContent>
        </Tabs>
        <div className="shrink-0 border-t border-border px-6 py-3 text-xs text-muted-foreground">
          pTerm <span data-testid="update-current-version">{version ?? '…'}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
