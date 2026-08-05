import { compareVersions, parseRelease } from './check'
import { readSkipped } from './store'
import type { UpdateCheckResult, UpdateStatus } from '../../shared/ipc'

export type { UpdateCheckResult, UpdateStatus }

/**
 * The public, unauthenticated releases endpoint.
 *
 * No token: the repo is public and the limit is 60 requests an hour per IP,
 * against a demand of roughly five a day. A token would be one more secret to
 * ship for no gain.
 */
export const RELEASES_URL = 'https://api.github.com/repos/paoloresteghini/PRCLI/releases/latest'

/** GitHub rejects a request with no User-Agent, with a 403. */
const USER_AGENT = 'PRCLI-update-check'

const TIMEOUT_MS = 10_000

export interface UpdateDeps {
  currentVersion: string
  fetchLatest: () => Promise<unknown>
  readSkipped: () => Promise<string | null>
}

/** The real network call. Injected as a dep, so no test performs one. */
export async function fetchLatestRelease(): Promise<unknown> {
  const response = await fetch(RELEASES_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  return response.json()
}

function failure(reason: string): UpdateCheckResult {
  return { status: 'failed', info: null, message: reason }
}

/**
 * One check, and every way it can decline to offer an update.
 *
 * `check` never rejects. Four distinct nothings collapse into `failed`
 * (network, rate limit, unreadable release tag, unreadable running version)
 * and two into a deliberate silence (`current`, `skipped`). The caller that
 * pushes the bar looks only for `available`; Settings shows all four, because
 * there the user asked and silence would read as a broken button.
 */
export function createUpdateService(deps: UpdateDeps): {
  check(options?: { respectSkip?: boolean }): Promise<UpdateCheckResult>
} {
  return {
    async check(options = {}): Promise<UpdateCheckResult> {
      const respectSkip = options.respectSkip ?? true

      let payload: unknown
      try {
        payload = await deps.fetchLatest()
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }

      const info = parseRelease(payload)
      if (info === null) return failure('No readable release at the feed')

      const order = compareVersions(info.version, deps.currentVersion)
      if (order === null) return failure(`Cannot compare ${info.version} with ${deps.currentVersion}`)
      if (order <= 0) return { status: 'current', info: null, message: null }

      if (respectSkip) {
        let skipped: string | null
        try {
          skipped = await deps.readSkipped()
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        // `>= 0`, not `=== 0`: skipping 0.3.0 and then seeing 0.2.0 arrive as
        // latest (a yanked release) should stay quiet too. The `?? -1` default
        // handles a corrupted skip string: if we cannot parse what was skipped,
        // we offer the update rather than silencing it forever based on an
        // unreadable value.
        if (skipped !== null && (compareVersions(skipped, info.version) ?? -1) >= 0) {
          return { status: 'skipped', info, message: null }
        }
      }

      return { status: 'available', info, message: null }
    },
  }
}

/** The service the app actually runs, wired to the real fetch and the real file. */
export function realUpdateService(currentVersion: string) {
  return createUpdateService({
    currentVersion,
    fetchLatest: fetchLatestRelease,
    readSkipped,
  })
}
