import type { UpdateCheckResult } from '../../shared/ipc'

/**
 * What Settings' "Updates" section reads after a check, for each outcome.
 *
 * Pulled out of the JSX rather than inlined, because the real check almost
 * never reaches `available`, `current` or `skipped` against this repo today
 * (see `tests/e2e/settingsUpdate.spec.ts`): the release feed 404s until a
 * repo and a release exist, so an inline ternary in `UpdatesSection.tsx` would
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
 *
 * `skippedVersion` is optional so every existing single-argument caller keeps
 * compiling unchanged. Passed, it names the version Settings' own Skip button
 * last recorded, and when the result names that same version the line gets a
 * "(skipped)" suffix. That is the only visible effect a Skip in Settings has:
 * `checkForUpdate` itself always ignores the skip (`respectSkip: false` in
 * `register.ts`), so without this suffix the result would say a skipped
 * release "is available" with nothing to show the skip took.
 */
export function updateResultText(result: UpdateCheckResult, skippedVersion?: string | null): string {
  switch (result.status) {
    case 'available':
    case 'skipped': {
      const text = `pTerm ${result.info?.version} is available`
      return result.info !== null && result.info.version === skippedVersion ? `${text} (skipped)` : text
    }
    case 'current':
      return 'pTerm is up to date'
    case 'failed':
      return `Could not check: ${result.message ?? 'unknown reason'}`
  }
}
