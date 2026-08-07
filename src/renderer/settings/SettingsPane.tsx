import { useEffect, useState } from 'react'
import type { NotificationConfig } from '../../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from '../ui/Dialog'
import { SettingsTabs } from './SettingsTabs'
import { SETTINGS_TABS, type SettingsTabId } from './tabs'
import { HooksSection } from './HooksSection'
import { ShellHistorySection } from './ShellHistorySection'
import { NotificationsSection } from './NotificationsSection'
import { UpdatesSection } from './UpdatesSection'

export function SettingsPane({
  open,
  onOpenChange,
  notifications,
  onNotificationsChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
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
      {/* Bounded and scrollable, which it was not until the shell-history row
          grew its disclosure paragraph. `DialogContent` centres itself with a
          -50% translate and sets no height, so a dialog taller than the window
          hangs off both ends with no way to reach either: measured 2026-08-06,
          the Updates row's `Check now` button went out of the viewport and
          Playwright's own scroll-into-view could not bring it back, because
          there was no scroll container to scroll. One tab's body is far
          shorter than the four stacked sections that provoked this, but a
          short window is still a short window. */}
      <DialogContent data-testid="settings-pane" className="scroll-thin max-h-[85vh] overflow-y-auto">
        <DialogTitle className="mb-3 text-xs uppercase tracking-wider text-label">
          Settings
        </DialogTitle>

        <SettingsTabs active={tab} onSelect={setTab} />

        {/* Only the selected section is mounted. Hooks, shell history and
            Updates each read their own file on mount, so selecting one of
            those tabs is what gives it a fresh read. Notifications takes its
            data as a prop instead, fetched once at app startup, so it has no
            mount read to trigger; it still unmounts and remounts with the
            others, which just costs it nothing since there is no listener or
            timer on it to clean up either. */}
        <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'notifications' ? (
            <NotificationsSection
              notifications={notifications}
              onNotificationsChange={onNotificationsChange}
            />
          ) : null}
          {tab === 'hooks' ? <HooksSection /> : null}
          {tab === 'shell-history' ? <ShellHistorySection /> : null}
          {tab === 'updates' ? <UpdatesSection /> : null}
        </div>

        <div className="mt-4 border-t border-border pt-2 text-[11px] text-label">
          pTerm <span data-testid="update-current-version">{version ?? '…'}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
