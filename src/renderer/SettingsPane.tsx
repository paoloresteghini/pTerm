import type { NotificationConfig } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { HooksSection } from './settings/HooksSection'
import { ShellHistorySection } from './settings/ShellHistorySection'
import { NotificationsSection } from './settings/NotificationsSection'
import { UpdatesSection } from './settings/UpdatesSection'

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bounded and scrollable, which it was not until the shell-history row
          grew its disclosure paragraph. `DialogContent` centres itself with a
          -50% translate and sets no height, so a dialog taller than the window
          hangs off both ends with no way to reach either: measured 2026-08-06,
          the Updates row's `Check now` button went out of the viewport and
          Playwright's own scroll-into-view could not bring it back, because
          there was no scroll container to scroll. Five sections is already
          more than a short window holds, so this is not about one paragraph. */}
      <DialogContent data-testid="settings-pane" className="scroll-thin max-h-[85vh] overflow-y-auto">
        <DialogTitle className="mb-3 text-xs uppercase tracking-wider text-faint">
          Settings
        </DialogTitle>
        <HooksSection />
        <ShellHistorySection />
        <NotificationsSection
          notifications={notifications}
          onNotificationsChange={onNotificationsChange}
        />
        <UpdatesSection />
      </DialogContent>
    </Dialog>
  )
}
