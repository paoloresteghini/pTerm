import { useState } from 'react'
import type { NotificationConfig, Rule, TabState } from '../../shared/ipc'
import { globalRuleOf, setGlobalRule } from '../globalRule'
import { StatusDot } from '../StatusDot'
import { errorMessage } from './errorMessage'

const STATES: TabState[] = ['waiting', 'crashed', 'idle', 'thinking', 'running', 'ended']
const SOUNDS = ['', 'Funk', 'Glass', 'Basso', 'Ping', 'Submarine']

export function NotificationsSection({
  notifications,
  onNotificationsChange,
}: {
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
}) {
  // Its own error, separate from the other sections': a failed notification
  // write must say so rather than leaving an unhandled rejection and a
  // checkbox that silently reverts the next time this pane opens.
  const [notifError, setNotifError] = useState<string | null>(null)

  const updateRule = (state: TabState, patch: Partial<Rule>): void => {
    if (!notifications) return
    const rules = setGlobalRule(notifications.rules, state, patch)
    window.pterm
      .updateNotifications({ rules })
      .then((config) => {
        setNotifError(null)
        onNotificationsChange(config)
      })
      .catch((reason: unknown) => setNotifError(errorMessage(reason)))
  }

  const toggleMuteWhenFocused = (): void => {
    if (!notifications) return
    window.pterm
      .updateNotifications({ muteWhenFocused: !notifications.muteWhenFocused })
      .then((config) => {
        setNotifError(null)
        onNotificationsChange(config)
      })
      .catch((reason: unknown) => setNotifError(errorMessage(reason)))
  }

  return (
    <section>
      {notifError ? (
        <p data-testid="notifications-error" className="mb-2 text-[11px] text-danger">
          {notifError}
        </p>
      ) : null}
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-label">
            <th className="pb-1 text-left font-normal">State</th>
            <th className="pb-1 text-left font-normal">Toast</th>
            <th className="pb-1 text-left font-normal">Sound</th>
            <th className="pb-1 text-left font-normal">Urgency</th>
          </tr>
        </thead>
        <tbody>
          {STATES.map((state) => {
            const rule = notifications ? globalRuleOf(notifications.rules, state) : undefined
            return (
              <tr key={state}>
                <td className="py-1 pr-2 text-muted">
                  <span className="flex items-center gap-1.5">
                    <StatusDot state={state} testid={`rule-dot-${state}`} />
                    {state}
                  </span>
                </td>
                <td className="pr-2">
                  <input
                    type="checkbox"
                    data-testid={`rule-toast-${state}`}
                    aria-label={`Toast on ${state}`}
                    checked={rule?.toast ?? false}
                    disabled={!notifications}
                    onChange={(event) => updateRule(state, { toast: event.target.checked })}
                  />
                </td>
                <td className="pr-2">
                  <select
                    data-testid={`rule-sound-${state}`}
                    aria-label={`Sound on ${state}`}
                    value={rule?.sound ?? ''}
                    disabled={!notifications}
                    onChange={(event) => updateRule(state, { sound: event.target.value || null })}
                    className="cursor-default border border-border bg-bg text-[10px] text-muted"
                  >
                    {SOUNDS.map((sound) => (
                      <option key={sound || 'none'} value={sound}>
                        {sound || '(none)'}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    data-testid={`rule-urgency-${state}`}
                    aria-label={`Urgency on ${state}`}
                    value={rule?.urgency ?? 'low'}
                    disabled={!notifications}
                    onChange={(event) =>
                      updateRule(state, { urgency: event.target.value === 'high' ? 'high' : 'low' })
                    }
                    className="cursor-default border border-border bg-bg text-[10px] text-muted"
                  >
                    <option value="low">low</option>
                    <option value="high">high</option>
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <label className="mt-3 flex items-center gap-2 text-[11px] text-muted">
        <input
          type="checkbox"
          data-testid="mute-when-focused"
          checked={notifications?.muteWhenFocused ?? false}
          disabled={!notifications}
          onChange={toggleMuteWhenFocused}
        />
        Mute toasts for the tab you are already looking at
      </label>
    </section>
  )
}
