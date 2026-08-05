import { app, type BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { realUpdateService } from './service'

/**
 * Not on the critical path of launch. The user is waiting for tmux restore to
 * put their sessions back; an update check racing it wins nothing and costs a
 * socket.
 */
const FIRST_DELAY_MS = 10_000

const INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Poll for a newer release, and push the first one worth mentioning.
 *
 * `PRCLI_UPDATE_CHECK=0` turns this off entirely. The switch exists for the
 * E2E suite, where every spec launches a real app: left unchecked, each
 * launch would put a request on api.github.com and make the suite's
 * behaviour depend on GitHub being up and on the rate limit. Nothing sets
 * the variable yet, so today every E2E launch still runs the real check;
 * wiring the harness to set it is tracked separately.
 *
 * **The scheduling here is not covered by any test.** The decision it wraps is
 * unit tested (`tests/unit/updateService.test.ts`). The bar it would feed is
 * not: the E2E spec that drives it is a later task, deferred while another
 * session rewrites `App.tsx` underneath it. The two timers, the env switch
 * and the `send` here are verified by reading only. That is a deliberate
 * trade: making them testable means injecting a clock and a sender through
 * main's startup, and the failure mode being bought off is "the bar never
 * appears", which is the same as not having built the feature.
 */
export function scheduleUpdateChecks(window: () => BrowserWindow | null): void {
  if (process.env.PRCLI_UPDATE_CHECK === '0') return

  const service = realUpdateService(app.getVersion())

  const run = async (): Promise<void> => {
    const result = await service.check()
    if (result.status !== 'available' || result.info === null) return
    window()?.webContents.send(CHANNELS.updateAvailable, result.info)
  }

  // `void`, and `check` never rejects, so neither of these can produce an
  // unhandled rejection out of a timer.
  setTimeout(() => void run(), FIRST_DELAY_MS)
  setInterval(() => void run(), INTERVAL_MS)
}
