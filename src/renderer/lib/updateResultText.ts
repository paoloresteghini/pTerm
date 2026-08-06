import type { UpdateCheckResult } from '../../shared/ipc'

/**
 * What Settings' "Updates" section reads after a check, for each outcome.
 *
 * Pulled out of the JSX rather than inlined, because the real check almost
 * never reaches `available`, `current` or `skipped` against this repo today
 * (see `tests/e2e/settingsUpdate.spec.ts`): the release feed 404s until a
 * repo and a release exist, so an inline ternary in `SettingsPane.tsx` would
 * have three of its four branches with no test of any kind, `failed` being
 * the only one an E2E run ever exercises. A pure function gives the other
 * three somewhere to be unit tested directly, with a fixture `UpdateCheckResult`
 * instead of a real network round trip.
 *
 * The switch has no `default`: `UpdateStatus` is a closed union of exactly
 * these four values, so TypeScript already refuses to compile this file if a
 * fifth status is ever added and left unhandled here. That is a stronger
 * guarantee than a runtime fallback string would give for a status that can
 * only exist if `src/main/update/service.ts` starts producing one.
 */
export function updateResultText(result: UpdateCheckResult): string {
  switch (result.status) {
    case 'available':
    case 'skipped':
      return `PRCLI ${result.info?.version} is available`
    case 'current':
      return 'PRCLI is up to date'
    case 'failed':
      return `Could not check: ${result.message ?? 'unknown reason'}`
  }
}
