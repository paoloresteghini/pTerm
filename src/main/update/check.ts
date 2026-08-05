/**
 * Reading a GitHub release, and deciding whether it is newer than us.
 *
 * Both are pure and neither touches the network: the fetch is `service.ts`'s
 * business, so every branch here is reachable from a unit test with a literal
 * object.
 */

import type { UpdateInfo } from '../../shared/ipc'

export type { UpdateInfo }

/** Exactly `major.minor.patch`, with an optional leading `v`. Nothing else. */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/

/**
 * The three numbers, or null for anything this app will not offer.
 *
 * A prerelease, a build suffix and a two-part version all read as null rather
 * than being coerced to something orderable. GitHub's `releases/latest`
 * already excludes prereleases, so in practice null means a hand-made tag,
 * and the right response to one is to say nothing.
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const match = VERSION.exec(raw.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * `-1` when `a` is older, `0` when equal, `1` when newer, `null` when either
 * side is unparseable.
 *
 * Null rather than a boolean, deliberately: a `isNewer(a, b): boolean` has to
 * answer *something* for an unparseable tag, and either answer is wrong. False
 * hides a real release behind a typo'd tag; true offers a download that is not
 * there. The caller is made to handle the third case.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/**
 * The two fields the app reads out of a `releases/latest` body, or null.
 *
 * `html_url` is the release *page*, not an asset: the app opens it in the
 * browser and the user picks the zip. Nothing here reads `assets`, so a
 * release whose upload failed still shows a page that says so, which is more
 * useful than silence.
 *
 * A rate-limit response is the case worth naming. GitHub answers one with a
 * JSON object carrying `message` and no release fields, so it arrives here as
 * a well-formed body with nothing in it, and reads as "no release".
 */
export function parseRelease(payload: unknown): UpdateInfo | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const tag = record.tag_name
  const url = record.html_url
  if (typeof tag !== 'string' || typeof url !== 'string') return null
  const version = parseVersion(tag)
  if (version === null) return null
  return { version: version.join('.'), url }
}
