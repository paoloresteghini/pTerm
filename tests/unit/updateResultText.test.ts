import { describe, it, expect } from 'vitest'
import { updateResultText } from '../../src/renderer/lib/updateResultText'
import type { UpdateCheckResult } from '../../src/shared/ipc'

// The e2e spec can only ever exercise `failed`, since the release feed 404s
// against a repo that does not exist yet (see `tests/e2e/settingsUpdate.spec.ts`).
// These four cover every branch of `UpdateStatus` directly, off fixtures
// rather than a real check.
describe('updateResultText', () => {
  it('names the version when one is available', () => {
    const result: UpdateCheckResult = {
      status: 'available',
      info: { version: '1.2.3', url: 'https://example.com/releases/1.2.3' },
      message: null,
    }
    expect(updateResultText(result)).toBe('PRCLI 1.2.3 is available')
  })

  // A skipped version is still the newest one out there; Settings' explicit
  // check ignores the skip (`respectSkip: false`), but the status can still
  // arrive here from a stale value if that ever changes, and reads the same
  // as `available` either way.
  it('names the version when it was previously skipped', () => {
    const result: UpdateCheckResult = {
      status: 'skipped',
      info: { version: '1.2.3', url: 'https://example.com/releases/1.2.3' },
      message: null,
    }
    expect(updateResultText(result)).toBe('PRCLI 1.2.3 is available')
  })

  it('says the app is up to date on current', () => {
    const result: UpdateCheckResult = { status: 'current', info: null, message: null }
    expect(updateResultText(result)).toBe('PRCLI is up to date')
  })

  it('surfaces the failure message', () => {
    const result: UpdateCheckResult = {
      status: 'failed',
      info: null,
      message: 'GitHub answered 404',
    }
    expect(updateResultText(result)).toBe('Could not check: GitHub answered 404')
  })

  it('falls back to "unknown reason" when a failure carries no message', () => {
    const result: UpdateCheckResult = { status: 'failed', info: null, message: null }
    expect(updateResultText(result)).toBe('Could not check: unknown reason')
  })
})
