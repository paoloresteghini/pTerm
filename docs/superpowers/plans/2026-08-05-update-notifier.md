# Update Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PRCLI notices a newer version on GitHub Releases and offers a bar that opens the release page; the user installs by hand.

**Architecture:** Main process polls the public GitHub releases API, compares the tag to `app.getVersion()` with a locally written semver compare, and pushes an `updateAvailable` event to the renderer. A dismissible bar renders below `TitleBar`. A skipped-version string lives in `~/.prcli/update.json`, deliberately outside `PrcliConfig`. Every failure is silent except in Settings, where the user asked.

**Tech Stack:** Electron 43, TypeScript 7, React 19, Vitest, Playwright (Electron), Tailwind 4, Electron Forge 7 + MakerZIP.

**Spec:** `docs/superpowers/specs/2026-08-05-update-notifier-design.md`

## Global Constraints

- **No new runtime dependencies.** The semver compare is ~20 lines written here. Do not add `semver`, `electron-updater`, or `update-electron-app`.
- **No em dashes** anywhere: code, comments, copy, commit messages. Use commas, colons, parentheses, or separate sentences.
- **No new `data-testid` beginning with `tab-`.** Over 27 existing e2e locators count tabs with `[data-testid^="tab-"]`; anything under that prefix inflates every one of them. All testids here start `update-`.
- **A failed update check is invisible.** Offline, rate limited, 5xx, malformed JSON, non-semver tag: no banner, no dialog, no renderer error. `console.error` in main is the only permitted output. Settings' explicit "Check now" is the single exception.
- **macOS/arm64 only.** One release asset. No architecture selection anywhere.
- **`PrcliConfig` stays at `version: 8`.** Nothing in this plan touches `src/main/state/store.ts`'s config shape, `migrate`, or `attachSavedFields`.
- **Comments must be true of the tree they land in**, not merely of the commit that writes them. If a later task falsifies a comment written by an earlier one, fix the comment in that later task.
- **Repo constant:** `paoloresteghini/PRCLI`. Confirm with the user before Task 9 pushes anything.

---

### Task 1: Version comparison and release parsing

Pure functions, no I/O. Everything else in this plan builds on them.

**Files:**
- Create: `src/main/update/check.ts`
- Test: `tests/unit/updateCheck.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseVersion(raw: string): [number, number, number] | null`
  - `compareVersions(a: string, b: string): number | null` (`-1` a older, `0` equal, `1` a newer, `null` if either is unparseable)
  - `parseRelease(payload: unknown): UpdateInfo | null`
  - `type UpdateInfo = { version: string; url: string }` (exported from `src/shared/ipc.ts` in Task 4; **for this task only**, declare it locally in `check.ts` and Task 4 replaces the local declaration with an import)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updateCheck.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { compareVersions, parseRelease, parseVersion } from '../../src/main/update/check'

describe('parseVersion', () => {
  it('reads a plain three-part version', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('tolerates the v prefix a git tag carries', () => {
    expect(parseVersion('v0.1.0')).toEqual([0, 1, 0])
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseVersion('  v2.0.1 ')).toEqual([2, 0, 1])
  })

  it('reads multi-digit fields as numbers, not characters', () => {
    expect(parseVersion('1.10.0')).toEqual([1, 10, 0])
  })

  // A prerelease is not an update this app offers. GitHub's releases/latest
  // does not return one, so this is the belt to that braces.
  it('refuses a prerelease tag', () => {
    expect(parseVersion('1.0.0-beta.1')).toBeNull()
  })

  it('refuses a two-part version', () => {
    expect(parseVersion('1.2')).toBeNull()
  })

  it('refuses a non-numeric field', () => {
    expect(parseVersion('1.x.0')).toBeNull()
  })

  it('refuses an empty string', () => {
    expect(parseVersion('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major first', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
  })

  it('orders by minor when majors match', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
  })

  it('orders by patch when major and minor match', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
  })

  it('reports equality', () => {
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0)
  })

  // The whole point of the null return: an unparseable tag is "no answer",
  // never "newer". A boolean-returning compare would have to pick one, and
  // picking "newer" offers a download that does not exist.
  it('answers null when either side is unparseable', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', 'garbage')).toBeNull()
  })
})

describe('parseRelease', () => {
  const payload = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0',
    // Fields the app deliberately ignores, present so the test proves it
    // reads only the two it names.
    assets: [{ browser_download_url: 'https://example.invalid/a.zip' }],
    body: 'notes',
  }

  it('takes the version and the release page url', () => {
    expect(parseRelease(payload)).toEqual({
      version: '0.2.0',
      url: 'https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0',
    })
  })

  it('normalises the tag, dropping the v', () => {
    expect(parseRelease({ ...payload, tag_name: 'v10.0.1' })?.version).toBe('10.0.1')
  })

  it('refuses a payload with no tag', () => {
    expect(parseRelease({ html_url: 'https://example.invalid' })).toBeNull()
  })

  it('refuses a payload with no url', () => {
    expect(parseRelease({ tag_name: 'v1.0.0' })).toBeNull()
  })

  it('refuses a payload whose tag is not a release version', () => {
    expect(parseRelease({ ...payload, tag_name: 'nightly' })).toBeNull()
  })

  // GitHub answers a rate limit with a 200-shaped JSON object carrying a
  // `message` and no release fields. That must read as "no release", not throw.
  it('refuses a rate-limit body', () => {
    expect(parseRelease({ message: 'API rate limit exceeded' })).toBeNull()
  })

  it('refuses a non-object', () => {
    expect(parseRelease(null)).toBeNull()
    expect(parseRelease('a string')).toBeNull()
    expect(parseRelease(42)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/updateCheck.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/main/update/check"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/update/check.ts`:

```ts
/**
 * Reading a GitHub release, and deciding whether it is newer than us.
 *
 * Both are pure and neither touches the network: the fetch is `service.ts`'s
 * business, so every branch here is reachable from a unit test with a literal
 * object.
 */

/**
 * What the renderer is told about an available release: the version to name
 * and the page to open.
 *
 * Declared here rather than imported for now. Task 4 moves it to
 * `src/shared/ipc.ts`, where the renderer can see it too, and replaces this
 * with an import.
 */
export interface UpdateInfo {
  version: string
  url: string
}

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/updateCheck.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/main/update/check.ts tests/unit/updateCheck.test.ts
git commit -m "Read a GitHub release, and say whether it is newer than us"
```

---

### Task 2: The skipped-version store

One string on disk, in its own file, so `PrcliConfig` never learns about it.

**Files:**
- Create: `src/main/update/store.ts`
- Test: `tests/unit/updateStore.test.ts`

**Interfaces:**
- Consumes: `configRoot()` from `src/main/state/store.ts` (already exported, line 411).
- Produces:
  - `readSkipped(): Promise<string | null>`
  - `writeSkipped(version: string): Promise<void>`
  - `skipPath(): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updateStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSkipped, skipPath, writeSkipped } from '../../src/main/update/store'

let dir: string
let previous: string | undefined

beforeEach(async () => {
  previous = process.env.PRCLI_CONFIG_DIR
  dir = await mkdtemp(join(tmpdir(), 'prcli-update-'))
  process.env.PRCLI_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.PRCLI_CONFIG_DIR
  else process.env.PRCLI_CONFIG_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

describe('skipPath', () => {
  // Read at call time, not at import time: a test that set the env var after
  // this module loaded would otherwise write into the developer's real ~/.prcli.
  it('resolves under PRCLI_CONFIG_DIR as it stands when called', () => {
    expect(skipPath()).toBe(join(dir, 'update.json'))
  })
})

describe('readSkipped', () => {
  it('answers null when nothing has been skipped', async () => {
    await expect(readSkipped()).resolves.toBeNull()
  })

  it('reads back what was written', async () => {
    await writeSkipped('0.2.0')
    await expect(readSkipped()).resolves.toBe('0.2.0')
  })

  it('answers null for a damaged file rather than throwing', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'update.json'), '{ not json', 'utf8')
    await expect(readSkipped()).resolves.toBeNull()
  })

  it('answers null for a well-formed file with the wrong shape', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'update.json'), JSON.stringify({ skipped: 42 }), 'utf8')
    await expect(readSkipped()).resolves.toBeNull()
  })
})

describe('writeSkipped', () => {
  it('creates the config directory when it does not exist yet', async () => {
    await rm(dir, { recursive: true, force: true })
    await writeSkipped('1.0.0')
    await expect(readSkipped()).resolves.toBe('1.0.0')
  })

  it('replaces an earlier skip rather than appending', async () => {
    await writeSkipped('0.2.0')
    await writeSkipped('0.3.0')
    await expect(readSkipped()).resolves.toBe('0.3.0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/updateStore.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/main/update/store"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/update/store.ts`:

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'

/**
 * One version string, in a file of its own.
 *
 * Deliberately NOT a field on `PrcliConfig`. That store is at `version: 8`,
 * and adding a field to it means a migration to 9 plus an entry in
 * `attachSavedFields` — both on the path that decides what survives a
 * relaunch, for a value nothing but this module ever reads. A file of its own
 * costs thirty lines and cannot break restore.
 *
 * `configRoot()` reads `PRCLI_CONFIG_DIR` at call time, so a test pointing
 * that at a temp dir gets its own file, same as `ConfigStore.defaultPath()`.
 */
export function skipPath(): string {
  return join(configRoot(), 'update.json')
}

interface SkipFile {
  skipped: string
}

/**
 * The version the user chose to skip, or null.
 *
 * Never rejects. A missing file is the normal state, and a damaged one is
 * worth exactly as little: the cost of reading either as "nothing skipped" is
 * one banner the user has already seen, which is a better failure than an
 * update check that throws on startup.
 */
export async function readSkipped(): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(skipPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { skipped } = parsed as Partial<SkipFile>
    return typeof skipped === 'string' ? skipped : null
  } catch {
    return null
  }
}

/** Atomic, the same temp-then-rename shape `notes/store.ts` uses. */
export async function writeSkipped(version: string): Promise<void> {
  const path = skipPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const body: SkipFile = { skipped: version }
  try {
    await writeFile(temp, JSON.stringify(body), 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/updateStore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/update/store.ts tests/unit/updateStore.test.ts
git commit -m "Remember one skipped version, outside the workspace config"
```

---

### Task 3: The check, with every failure mode

Composes Tasks 1 and 2 with a fetch. The fetch is injected, so no test touches the network.

**Files:**
- Create: `src/main/update/service.ts`
- Test: `tests/unit/updateService.test.ts`

**Interfaces:**
- Consumes: `compareVersions`, `parseRelease`, `UpdateInfo` from `./check`; `readSkipped` from `./store`.
- Produces:
  - `type UpdateStatus = 'available' | 'current' | 'skipped' | 'failed'`
  - `type UpdateCheckResult = { status: UpdateStatus; info: UpdateInfo | null; message: string | null }`
  - `interface UpdateDeps { currentVersion: string; fetchLatest: () => Promise<unknown>; readSkipped: () => Promise<string | null> }`
  - `createUpdateService(deps: UpdateDeps): { check(options?: { respectSkip?: boolean }): Promise<UpdateCheckResult> }`
  - `RELEASES_URL: string`
  - `fetchLatestRelease(): Promise<unknown>` (the real network call, used by Task 5, not exercised by any test)

`UpdateStatus` and `UpdateCheckResult` move to `src/shared/ipc.ts` in Task 4 and are re-imported here.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/updateService.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createUpdateService, RELEASES_URL } from '../../src/main/update/service'

const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/paoloresteghini/PRCLI/releases/tag/${tag}`,
})

const service = (options: {
  currentVersion?: string
  fetchLatest?: () => Promise<unknown>
  skipped?: string | null
}) =>
  createUpdateService({
    currentVersion: options.currentVersion ?? '0.1.0',
    fetchLatest: options.fetchLatest ?? (() => Promise.resolve(release('v0.2.0'))),
    readSkipped: () => Promise.resolve(options.skipped ?? null),
  })

describe('the feed url', () => {
  // Pinned because a typo here is invisible: a wrong repo answers 404, the
  // check fails silently by design, and the app simply never offers an update.
  it('names the public repo and the latest release', () => {
    expect(RELEASES_URL).toBe('https://api.github.com/repos/paoloresteghini/PRCLI/releases/latest')
  })
})

describe('check', () => {
  it('reports a newer release as available', async () => {
    const result = await service({ currentVersion: '0.1.0' }).check()
    expect(result.status).toBe('available')
    expect(result.info).toEqual({
      version: '0.2.0',
      url: 'https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0',
    })
  })

  it('reports the same version as current', async () => {
    const result = await service({ currentVersion: '0.2.0' }).check()
    expect(result.status).toBe('current')
    expect(result.info).toBeNull()
  })

  // A dev build ahead of the last release. Not an error, and not an offer to
  // downgrade.
  it('reports an older release as current', async () => {
    const result = await service({ currentVersion: '0.3.0' }).check()
    expect(result.status).toBe('current')
  })

  it('reports a skipped version as skipped, not available', async () => {
    const result = await service({ currentVersion: '0.1.0', skipped: '0.2.0' }).check()
    expect(result.status).toBe('skipped')
    // The info still comes back. Settings shows what was skipped; only the
    // background push consults the status.
    expect(result.info?.version).toBe('0.2.0')
  })

  it('still offers a release newer than the skipped one', async () => {
    const result = await service({
      currentVersion: '0.1.0',
      skipped: '0.2.0',
      fetchLatest: () => Promise.resolve(release('v0.3.0')),
    }).check()
    expect(result.status).toBe('available')
  })

  // An explicit "Check now" is the user asking, so a past skip must not
  // silence the answer they just requested.
  it('ignores the skip when the caller says not to respect it', async () => {
    const result = await service({ currentVersion: '0.1.0', skipped: '0.2.0' }).check({
      respectSkip: false,
    })
    expect(result.status).toBe('available')
  })

  it('reports a network failure as failed, with a message', async () => {
    const result = await service({
      fetchLatest: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')),
    }).check()
    expect(result.status).toBe('failed')
    expect(result.info).toBeNull()
    expect(result.message).toContain('ENOTFOUND')
  })

  it('reports a rate-limit body as failed', async () => {
    const result = await service({
      fetchLatest: () => Promise.resolve({ message: 'API rate limit exceeded' }),
    }).check()
    expect(result.status).toBe('failed')
  })

  it('reports a non-semver tag as failed rather than as an update', async () => {
    const result = await service({
      fetchLatest: () => Promise.resolve(release('nightly')),
    }).check()
    expect(result.status).toBe('failed')
    expect(result.info).toBeNull()
  })

  // The one case that is neither the app's fault nor GitHub's: a locally
  // built version string the compare cannot read. Saying nothing beats
  // offering a download against an unknown baseline.
  it('reports an unreadable current version as failed', async () => {
    const result = await service({ currentVersion: '43.2.0-dev' }).check()
    expect(result.status).toBe('failed')
  })

  it('never rejects, whatever the fetch does', async () => {
    await expect(
      service({ fetchLatest: () => Promise.reject(new Error('boom')) }).check(),
    ).resolves.toMatchObject({ status: 'failed' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/updateService.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/main/update/service"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/update/service.ts`:

```ts
import { compareVersions, parseRelease, type UpdateInfo } from './check'
import { readSkipped } from './store'

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

export type UpdateStatus = 'available' | 'current' | 'skipped' | 'failed'

export interface UpdateCheckResult {
  status: UpdateStatus
  /**
   * The release, when there is one to name. Present for `skipped` as well as
   * `available`, so Settings can say what was skipped; only the background
   * push looks at `status` to decide whether to show a bar.
   */
  info: UpdateInfo | null
  /** Why it failed, for Settings alone. Never shown by the bar. */
  message: string | null
}

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
        const skipped = await deps.readSkipped()
        // `>= 0`, not `=== 0`: skipping 0.3.0 and then seeing 0.2.0 arrive as
        // latest (a yanked release) should stay quiet too.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/updateService.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole unit suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green, no typecheck output.

- [ ] **Step 6: Commit**

```bash
git add src/main/update/service.ts tests/unit/updateService.test.ts
git commit -m "Decide whether to offer an update, and stay quiet six ways"
```

---

### Task 4: Wire types and channels through the IPC boundary

Types move to `src/shared/ipc.ts` so the renderer can see them. No behaviour.

**Files:**
- Modify: `src/shared/ipc.ts` (the `CHANNELS` object at line 6, and the `PrcliApi` interface at line 484)
- Modify: `src/main/update/check.ts` (drop the local `UpdateInfo`, import it)
- Modify: `src/main/update/service.ts` (drop the local `UpdateStatus`/`UpdateCheckResult`, import them)
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `UpdateInfo`, `UpdateStatus`, `UpdateCheckResult` from Tasks 1 and 3.
- Produces:
  - `CHANNELS.updateAvailable = 'prcli:updateAvailable'`, `CHANNELS.checkForUpdate = 'prcli:checkForUpdate'`, `CHANNELS.skipUpdate = 'prcli:skipUpdate'`
  - `PrcliApi.onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void`
  - `PrcliApi.checkForUpdate(): Promise<UpdateCheckResult>`
  - `PrcliApi.skipUpdate(version: string): Promise<void>`

- [ ] **Step 1: Add the three channels**

In `src/shared/ipc.ts`, add to the `CHANNELS` object, after `openEditor: 'prcli:openEditor',`:

```ts
  updateAvailable: 'prcli:updateAvailable',
  checkForUpdate: 'prcli:checkForUpdate',
  skipUpdate: 'prcli:skipUpdate',
```

- [ ] **Step 2: Add the three types**

In `src/shared/ipc.ts`, above the `PrcliApi` interface:

```ts
/** A release newer than the running app: the version to name, the page to open. */
export interface UpdateInfo {
  version: string
  url: string
}

/**
 * Why a check produced no bar, kept apart so Settings can say which.
 *
 * `failed` folds four unrelated nothings together (no network, rate limited,
 * an unreadable release tag, an unreadable running version) because the bar
 * treats them identically: it does not appear. The distinction that matters
 * to a user is `failed` against `current`, and that one is kept.
 */
export type UpdateStatus = 'available' | 'current' | 'skipped' | 'failed'

export interface UpdateCheckResult {
  status: UpdateStatus
  info: UpdateInfo | null
  message: string | null
}
```

- [ ] **Step 3: Add the three methods to `PrcliApi`**

At the end of the `PrcliApi` interface in `src/shared/ipc.ts`:

```ts
  /**
   * A release newer than this build, pushed by main when it finds one.
   *
   * Push rather than poll: the check runs on main's own schedule, and the
   * renderer has nothing useful to ask before then. Returns an unsubscribe
   * function, like `onData` and `onExit`.
   */
  onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void
  /**
   * Check right now and report everything, failures included.
   *
   * The one place an update failure is allowed to be visible: Settings' button
   * is the user asking, and a button that answers nothing reads as broken.
   * Ignores a previously skipped version for the same reason.
   */
  checkForUpdate(): Promise<UpdateCheckResult>
  /** Never mention this version again. Persisted outside the workspace config. */
  skipUpdate(version: string): Promise<void>
```

- [ ] **Step 4: Move the local type declarations**

In `src/main/update/check.ts`, delete the local `UpdateInfo` interface and its comment, and replace with:

```ts
import type { UpdateInfo } from '../../shared/ipc'

export type { UpdateInfo }
```

In `src/main/update/service.ts`, delete the local `UpdateStatus` and `UpdateCheckResult` declarations and their comments, and add to the imports at the top:

```ts
import type { UpdateCheckResult, UpdateStatus } from '../../shared/ipc'

export type { UpdateCheckResult, UpdateStatus }
```

Move the comment explaining the four-nothings fold to the `UpdateStatus` declaration in `src/shared/ipc.ts` (Step 2 already places it there). Do not leave a copy behind in `service.ts`.

- [ ] **Step 5: Expose the three methods in preload**

In `src/preload/index.ts`, add to the imports:

```ts
  type UpdateCheckResult,
  type UpdateInfo,
```

and add to the `api` object:

```ts
  onUpdateAvailable: (listener: (info: UpdateInfo) => void) => {
    const handler = (_event: IpcRendererEvent, payload: UpdateInfo): void => listener(payload)
    ipcRenderer.on(CHANNELS.updateAvailable, handler)
    return () => ipcRenderer.removeListener(CHANNELS.updateAvailable, handler)
  },
  checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(CHANNELS.checkForUpdate),
  skipUpdate: (version: string): Promise<void> => ipcRenderer.invoke(CHANNELS.skipUpdate, version),
```

- [ ] **Step 6: Verify the boundary compiles and nothing regressed**

Run: `npm run typecheck && npm test`
Expected: no typecheck output; the unit suite still green at its previous count.

`api` is typed `PrcliApi`, so a method declared in the interface and missing from the object is a typecheck error. That is what verifies this task: there is no behaviour here to test, and the wiring is proved by Task 7's e2e.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/update/check.ts src/main/update/service.ts
git commit -m "Give the renderer a way to hear about a new release"
```

---

### Task 5: Handle the channels, and schedule the check

**Files:**
- Modify: `src/main/ipc/register.ts` (imports at the top; handlers near `CHANNELS.hooksState` at line 1330)
- Modify: `src/main/index.ts` (imports; the `app.whenReady()` block, after `createWindow()`)

**Interfaces:**
- Consumes: `realUpdateService` from `src/main/update/service.ts`, `writeSkipped` from `src/main/update/store.ts`, the three channels from Task 4.
- Produces: `scheduleUpdateChecks(window: () => BrowserWindow | null): void` in `src/main/update/schedule.ts`.

- [ ] **Step 1: Add the two handlers**

In `src/main/ipc/register.ts`, add to the imports:

```ts
import { realUpdateService } from '../update/service'
import { writeSkipped } from '../update/store'
```

and beside `CHANNELS.hooksState` (line 1330):

```ts
  // Explicitly ignores a previous skip: the user pressed a button, and the
  // answer they get must be about the release, not about a decision they made
  // last month. The background check in `schedule.ts` is the one that respects it.
  ipcMain.handle(CHANNELS.checkForUpdate, () =>
    realUpdateService(app.getVersion()).check({ respectSkip: false }),
  )
  ipcMain.handle(CHANNELS.skipUpdate, (_event, version: string) => writeSkipped(version))
```

`app` is not currently imported in `register.ts`. Add it to the existing `from 'electron'` import on line 1: `import { app, dialog, ipcMain, type BrowserWindow } from 'electron'`.

- [ ] **Step 2: Write the scheduler**

Create `src/main/update/schedule.ts`:

```ts
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
 * `PRCLI_UPDATE_CHECK=0` turns this off entirely. The E2E suite sets it: every
 * spec launches a real app, and without the switch each launch would put a
 * request on api.github.com and make the suite's behaviour depend on GitHub
 * being up and on the rate limit.
 *
 * **The scheduling here is not covered by any test.** The decision it wraps is
 * (`tests/unit/updateService.test.ts`, twelve cases) and so is the bar it
 * feeds (`tests/e2e/update.spec.ts`), but the two timers, the env switch and
 * the `send` are verified by reading only. That is a deliberate trade: making
 * them testable means injecting a clock and a sender through main's startup,
 * and the failure mode being bought off is "the bar never appears", which is
 * the same as not having built the feature.
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
```

- [ ] **Step 3: Call it from main**

In `src/main/index.ts`, add to the imports:

```ts
import { scheduleUpdateChecks } from './update/schedule'
```

and in the `app.whenReady()` block, immediately after `createWindow()`:

```ts
  scheduleUpdateChecks(() => mainWindow)
```

- [ ] **Step 4: Set the switch in the E2E harness**

In `tests/e2e/harness.ts`, add to the `env` block in `launchApp`, after `PRCLI_CLAUDE_HOME`:

```ts
      // Off, in every spec. Each one launches a real app, so without this the
      // suite would put a request on api.github.com per launch and its
      // behaviour would depend on GitHub being reachable and on the 60/hour
      // limit. `update.spec.ts` drives the push itself instead.
      PRCLI_UPDATE_CHECK: '0',
```

Note: `tests/unit/e2eSafety.test.ts`'s `GUARDED_VARS` is a list of vars that must be *present*, not an exhaustive list of the env block. A sixth var does not break it. Confirm by running that test in the next step.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`
Expected: unit suite green including `e2eSafety.test.ts`; no typecheck output.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/register.ts src/main/index.ts src/main/update/schedule.ts tests/e2e/harness.ts
git commit -m "Poll for a release on a timer, and answer a check from Settings"
```

---

### Task 6: The bar

**Files:**
- Create: `src/renderer/UpdateBar.tsx`
- Modify: `src/renderer/App.tsx` (imports at line 1-20; state near the other `useState` calls; the render at line 781-786)

**Interfaces:**
- Consumes: `UpdateInfo` from `src/shared/ipc`, `window.prcli.onUpdateAvailable` / `skipUpdate` from Task 4.
- Produces: `UpdateBar` component; testids `update-bar`, `update-version`, `update-download`, `update-skip`, `update-dismiss`.

There is no component-test setup in this repo (no `@testing-library`, no jsdom). Renderer components are verified by Playwright, so this task's test is Task 7 and the two run together. Do not invent a component harness for one bar.

- [ ] **Step 1: Write the component**

Create `src/renderer/UpdateBar.tsx`:

```tsx
import type { UpdateInfo } from '../shared/ipc'

/**
 * A strip below the title bar saying a newer PRCLI exists.
 *
 * Below `TitleBar` rather than inside it, deliberately. `TitleBar` is the
 * window's only `drag-region` and its own comment records why nothing in it is
 * clickable: a drag region swallows pointer events, so every interactive child
 * needs `no-drag`, and there is currently no such list to keep correct. Three
 * buttons would start one.
 *
 * There is no automatic download behind `Download`. macOS auto-apply needs a
 * code-signed bundle and this app is unsigned, so the honest gesture is to
 * open the release page and let the user take the zip. See the spec at
 * `docs/superpowers/specs/2026-08-05-update-notifier-design.md`.
 */
export function UpdateBar({
  info,
  onDownload,
  onSkip,
  onDismiss,
}: {
  info: UpdateInfo
  onDownload: () => void
  onSkip: () => void
  onDismiss: () => void
}) {
  return (
    <div
      data-testid="update-bar"
      className="flex h-[26px] shrink-0 items-center justify-center gap-3 border-b border-border bg-surface px-3 text-[11px]"
    >
      <span data-testid="update-version" className="text-muted">
        PRCLI {info.version} available
      </span>
      <button
        data-testid="update-download"
        onClick={onDownload}
        className="text-fg underline underline-offset-2 hover:text-white"
      >
        Download
      </button>
      <button
        data-testid="update-skip"
        onClick={onSkip}
        className="text-faint hover:text-muted"
      >
        Skip this version
      </button>
      <button
        data-testid="update-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-faint hover:text-muted"
      >
        ✕
      </button>
    </div>
  )
}
```

If `text-fg`, `text-muted`, `text-faint`, `bg-surface` or `border-border` are not all defined in `src/renderer/index.css`, use the ones that are; `SettingsPane.tsx` lines 100-155 is the reference for which exist. Do not introduce a new colour token for this bar.

- [ ] **Step 2: Hold the update in App state**

In `src/renderer/App.tsx`, add the import beside the other component imports:

```tsx
import { UpdateBar } from './UpdateBar'
```

and to the shared-type import block:

```tsx
import type { UpdateInfo } from '../shared/ipc'
```

(If `App.tsx` already imports from `'../shared/ipc'`, add `UpdateInfo` to that import rather than adding a second one.)

Beside the other `useState` calls, add:

```tsx
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
```

and beside the other subscription effects:

```tsx
  useEffect(() => window.prcli.onUpdateAvailable(setUpdate), [])
```

- [ ] **Step 3: Render it**

In `src/renderer/App.tsx`, at line 785, immediately after `<TitleBar />`:

```tsx
      {update ? (
        <UpdateBar
          info={update}
          onDownload={() => {
            void window.prcli.openExternal(update.url)
            setUpdate(null)
          }}
          onSkip={() => {
            void window.prcli.skipUpdate(update.version)
            setUpdate(null)
          }}
          onDismiss={() => setUpdate(null)}
        />
      ) : null}
```

- [ ] **Step 4: Add the one missing channel**

`window.prcli.openExternal` does not exist yet. Add it, in the same three places Task 4 used:

`src/shared/ipc.ts`, in `CHANNELS`:

```ts
  openExternal: 'prcli:openExternal',
```

in `PrcliApi`:

```ts
  /**
   * Hand a URL to the default browser.
   *
   * In main because the renderer has no `shell`, and narrow on purpose: the
   * handler refuses anything that is not http(s), so a URL that arrived from
   * the network cannot become `file:` or a custom scheme registered by another
   * app on this machine.
   */
  openExternal(url: string): Promise<void>
```

`src/preload/index.ts`, in `api`:

```ts
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),
```

`src/main/ipc/register.ts`, beside the update handlers from Task 5 (and add `shell` to the `from 'electron'` import):

```ts
  ipcMain.handle(CHANNELS.openExternal, async (_event, url: string) => {
    // The URL came off the network. `shell.openExternal` will hand a `file:`
    // or a custom scheme to whatever claims it, so the scheme is checked here
    // rather than trusted from the release feed.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    await shell.openExternal(url)
  })
```

- [ ] **Step 5: Test the scheme guard**

That guard has branches worth pinning, and it is pure enough to lift. Extract it to `src/main/update/openable.ts`:

```ts
/** Whether a URL off the network may be handed to the user's browser. */
export function isOpenable(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
```

and rewrite the handler body as:

```ts
  ipcMain.handle(CHANNELS.openExternal, async (_event, url: string) => {
    // The URL came off the network. See `isOpenable`.
    if (!isOpenable(url)) return
    await shell.openExternal(url)
  })
```

Create `tests/unit/openable.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isOpenable } from '../../src/main/update/openable'

describe('isOpenable', () => {
  it('allows the release page', () => {
    expect(isOpenable('https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0')).toBe(true)
  })

  it('allows plain http', () => {
    expect(isOpenable('http://example.invalid/notes')).toBe(true)
  })

  // The reason this function exists: the URL arrives from a network feed, and
  // shell.openExternal hands a file: URL to Finder without asking.
  it('refuses file:', () => {
    expect(isOpenable('file:///Applications/Calculator.app')).toBe(false)
  })

  it('refuses a custom scheme another app may have claimed', () => {
    expect(isOpenable('vscode://file/etc/passwd')).toBe(false)
  })

  it('refuses javascript:', () => {
    expect(isOpenable('javascript:alert(1)')).toBe(false)
  })

  it('refuses a string that is not a URL at all', () => {
    expect(isOpenable('not a url')).toBe(false)
    expect(isOpenable('')).toBe(false)
  })
})
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/unit/openable.test.ts && npm test && npm run typecheck`
Expected: 6 new tests pass; whole unit suite green; no typecheck output.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/UpdateBar.tsx src/renderer/App.tsx src/shared/ipc.ts src/preload/index.ts src/main/ipc/register.ts src/main/update/openable.ts tests/unit/openable.test.ts
git commit -m "Show a bar when a newer PRCLI exists"
```

---

### Task 7: Prove the bar end to end

**Files:**
- Create: `tests/e2e/update.spec.ts`

**Interfaces:**
- Consumes: `launchApp`, `killServer` from `tests/e2e/harness.ts`; the testids from Task 6.
- Produces: nothing.

**Two constraints that shape this spec, both learned the hard way:**

1. **The push must come from main.** `window.prcli` cannot be stubbed from the page: `contextBridge` freezes it, the object and every method are `writable: false, configurable: false`, a plain assignment is a silent no-op and `defineProperty` throws. A spec written as "stub the bridge, then assert" passes against a broken implementation. Use `electronApp.evaluate`, which runs in main.
2. **The channel name must be a string literal inside the evaluate.** That callback is serialised and run in main's context; it cannot import `CHANNELS`. Pin the literal against the constant with an assertion outside the evaluate, so a renamed channel fails loudly rather than making the test silently push nothing.

**A divergence from the spec, recorded here:** the spec said the skip test should relaunch and assert no bar appears. It cannot, because this spec pushes `updateAvailable` directly and so bypasses the skip filter that lives in main's `check()`. The filter is covered by `tests/unit/updateService.test.ts` ("reports a skipped version as skipped"). What e2e proves instead is that clicking Skip reaches disk: it reads `update.json` out of the test's own config dir. Between them the two halves cover what the relaunch test was meant to.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/update.spec.ts`:

```ts
import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNELS } from '../../src/shared/ipc'
import { killServer, launchApp } from './harness'

/**
 * The update bar: that it appears when main says a release exists, that each
 * of its three buttons dismisses it, and that Skip reaches disk.
 *
 * No network. `PRCLI_UPDATE_CHECK=0` (set for every spec in `harness.ts`)
 * keeps the scheduled check from ever running, and this file pushes the event
 * main would have pushed.
 *
 * **What this file does NOT see:**
 *
 * - **the check itself.** Nothing here fetches, parses a release, compares
 *   versions or consults the skip file. All of that is
 *   `tests/unit/updateService.test.ts` and `updateCheck.test.ts`;
 * - **the schedule.** The two timers in `src/main/update/schedule.ts` are
 *   switched off here, so neither the 10s first check nor the 6h interval is
 *   exercised by any test;
 * - **what Download opens.** See the note on that test below;
 * - **the Settings section.** `settings-pane` is never opened here.
 */

const SOCKET = 'prcli-e2e-update'

const VERSION = '99.0.0'
const RELEASE_URL = 'https://github.com/paoloresteghini/PRCLI/releases/tag/v99.0.0'

let app: ElectronApplication
let configDir: string
let projectsRoot: string
let claudeHome: string
let userDataDir: string
let claudeSettings: string

test.beforeEach(async () => {
  await killServer(SOCKET)
  configDir = await mkdtemp(join(tmpdir(), 'prcli-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-projects-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-claude-'))
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-userdata-'))
  claudeSettings = join(claudeHome, 'settings.json')
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings,
    claudeHome,
    userDataDir,
  })
})

test.afterEach(async () => {
  await app.close().catch(() => undefined)
  await killServer(SOCKET)
  await Promise.all(
    [configDir, projectsRoot, claudeHome, userDataDir].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  )
})

/**
 * Push the event main's scheduler would have pushed.
 *
 * From main, not from the page: `contextBridge` freezes `window.prcli`, so no
 * spec can stub, delay or gate a bridge method. The channel is a literal here
 * because this callback is serialised into main and cannot import `CHANNELS`;
 * the assertion above it is what keeps the literal honest.
 */
async function pushUpdate(): Promise<void> {
  expect(CHANNELS.updateAvailable).toBe('prcli:updateAvailable')
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const [window] = BrowserWindow.getAllWindows()
      window.webContents.send('prcli:updateAvailable', payload)
    },
    { version: VERSION, url: RELEASE_URL },
  )
}

test('no bar until main says there is a release', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)
})

test('the bar names the version main pushed', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await expect(page.getByTestId('update-bar')).toBeVisible()
  // The version, not merely that a bar exists: a bar hardcoding a string would
  // pass a mere visibility check.
  await expect(page.getByTestId('update-version')).toHaveText(`PRCLI ${VERSION} available`)
})

test('the bar sits below the title bar, not inside it', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await expect(page.getByTestId('update-bar')).toBeVisible()
  const titleBar = await page.getByTestId('titlebar').boundingBox()
  const bar = await page.getByTestId('update-bar').boundingBox()
  expect(titleBar).not.toBeNull()
  expect(bar).not.toBeNull()
  // Placement is the design decision this component exists to hold: inside the
  // title bar it would need `no-drag` on all three buttons. A geometric
  // assertion survives a restyle in a way a DOM-parent assertion would not.
  expect(bar!.y).toBeGreaterThanOrEqual(titleBar!.y + titleBar!.height - 1)
})

test('dismiss hides the bar', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await page.getByTestId('update-dismiss').click()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)
})

test('skip hides the bar and writes the version to disk', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await page.getByTestId('update-skip').click()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)

  // The disk half. Without it this test proves only that a button hides a div,
  // and the skip would silently stop persisting the day the handler broke.
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(configDir, 'update.json'), 'utf8')) as unknown
      } catch {
        return null
      }
    })
    .toEqual({ skipped: VERSION })
})

/**
 * Download hides the bar. Whether it opened a browser is NOT asserted.
 *
 * `shell.openExternal` cannot be intercepted from a spec: Electron exposes
 * `shell`'s members as non-writable, so the monkeypatch a test would need
 * either throws or silently no-ops, and a test built on a patch that did not
 * install passes against a broken app. The remaining risk is one line,
 * `window.prcli.openExternal(update.url)` in `App.tsx`, whose scheme guard IS
 * covered by `tests/unit/openable.test.ts`.
 */
test('download hides the bar', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await pushUpdate()
  await page.getByTestId('update-download').click()
  await expect(page.getByTestId('update-bar')).toHaveCount(0)
})
```

- [ ] **Step 2: Run the spec**

Run: `npx playwright test tests/e2e/update.spec.ts`
Expected: 6 passed.

If a launch stalls in `firstWindow`, that is the known AppKit crash-restore alert, not this spec. Rerun the file alone before investigating.

- [ ] **Step 3: Prove the spec can fail**

Sabotage, one at a time, running `npx playwright test tests/e2e/update.spec.ts` after each and restoring before the next:

1. Make `UpdateBar` return `null`. Expected: 5 failed, 1 passed (the "no bar until" test survives, correctly).
2. Change `onSkip` in `App.tsx` to `setUpdate(null)` alone, dropping the `skipUpdate` call. Expected: exactly the skip test fails, on the disk poll.
3. Move `<UpdateBar>` above `<TitleBar />`. Expected: exactly the placement test fails.

Record the three counts in the spec's header comment as a measured line, dated. This is the step that keeps the file from becoming another green suite that catches nothing.

- [ ] **Step 4: Run the whole e2e suite**

Run: `npm run e2e`
Expected: the previous baseline plus 6.

Note the count before and after. If any pre-existing spec reddens, the likely cause is `PRCLI_UPDATE_CHECK` in `harness.ts` or the new `openExternal` channel, not this file.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/update.spec.ts
git commit -m "Prove the update bar appears, dismisses and persists a skip"
```

---

### Task 8: The Settings section

**Files:**
- Modify: `src/renderer/SettingsPane.tsx` (state near the top of the component; a new `<section>` after the notifications section)
- Modify: `tests/e2e/update.spec.ts` (one more test)

**Interfaces:**
- Consumes: `window.prcli.checkForUpdate` from Task 4, `window.prcli.openExternal` from Task 6.
- Produces: testids `update-current-version`, `update-check-now`, `update-check-result`.

- [ ] **Step 1: Add the section**

In `src/renderer/SettingsPane.tsx`, add to the component's state:

```tsx
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
```

with `import type { UpdateCheckResult } from '../shared/ipc'` added to the imports, and a new section after the notifications one, following the same `<section className="mb-4 border-b border-border pb-3">` shape the hooks section uses:

```tsx
        <section className="mb-4 border-b border-border pb-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-faint">Updates</span>
            <span data-testid="update-current-version" className="text-[11px] text-muted">
              {version ?? '…'}
            </span>
          </div>

          {/* The one place an update failure is visible. Everywhere else a
              failed check is silent by design; here the user pressed a button,
              and a button that answers nothing reads as broken. */}
          {updateResult ? (
            <p data-testid="update-check-result" className="mb-2 text-[11px] text-muted">
              {updateResult.status === 'available' || updateResult.status === 'skipped'
                ? `PRCLI ${updateResult.info?.version} is available`
                : updateResult.status === 'current'
                  ? 'PRCLI is up to date'
                  : `Could not check: ${updateResult.message ?? 'unknown reason'}`}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              data-testid="update-check-now"
              disabled={checking}
              onClick={() => {
                setChecking(true)
                window.prcli
                  .checkForUpdate()
                  .then(setUpdateResult)
                  .catch((reason: unknown) =>
                    setUpdateResult({
                      status: 'failed',
                      info: null,
                      message: errorMessage(reason),
                    }),
                  )
                  .finally(() => setChecking(false))
              }}
            >
              {checking ? 'Checking…' : 'Check now'}
            </Button>
            {updateResult?.info ? (
              <Button onClick={() => void window.prcli.openExternal(updateResult.info!.url)}>
                Open release page
              </Button>
            ) : null}
          </div>
        </section>
```

`errorMessage` already exists in this file. `version` does not: the renderer has no `app.getVersion()`, so add a fourth channel, in the same three places Task 4 used.

`src/shared/ipc.ts`, in `CHANNELS`:

```ts
  appVersion: 'prcli:appVersion',
```

in `PrcliApi`:

```ts
  /**
   * The running build's version, from `package.json` by way of
   * `app.getVersion()`.
   *
   * Asked for rather than baked into the bundle at build time: a version
   * compiled into the renderer would be whatever Vite saw, which in a dev run
   * is the source tree and in a packaged run is the same file main reads. One
   * of those two would eventually drift, and the drift would show up as the
   * app comparing releases against a version it is not.
   */
  appVersion(): Promise<string>
```

`src/preload/index.ts`, in `api`:

```ts
  appVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appVersion),
```

`src/main/ipc/register.ts`, beside the update handlers from Task 5:

```ts
  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion())
```

and in `SettingsPane.tsx`, beside the other state and effects:

```tsx
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    // Fire and forget, like the hooks read beside it: a version that fails to
    // arrive leaves an ellipsis, which is a better failure than a dialog that
    // will not open.
    window.prcli
      .appVersion()
      .then(setVersion)
      .catch(() => undefined)
  }, [])
```

- [ ] **Step 2: Add the e2e test**

Append to `tests/e2e/update.spec.ts`:

```ts
/**
 * Settings shows the running version and reports a failed check out loud.
 *
 * The check really runs and really fails: nothing stubs the network, and the
 * test host may or may not have one. That is why the assertion is on the two
 * outcomes rather than on a single string. What it pins is that the button
 * produces *an answer*, which is the whole reason this section exists.
 */
test('settings names the version and answers a check', async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('prcli:menuCommand', 'settings')
  })
  await expect(page.getByTestId('settings-pane')).toBeVisible()
  await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)

  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-check-result')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('update-check-result')).toHaveText(
    /is available|up to date|Could not check/,
  )
})
```

If `menuCommand`'s `'settings'` value differs from that literal, read it from `MenuCommand` in `src/shared/ipc.ts` and pin it with an `expect` outside the evaluate, exactly as `pushUpdate` pins its channel.

- [ ] **Step 3: Run and verify it can fail**

Run: `npx playwright test tests/e2e/update.spec.ts`
Expected: 7 passed.

Then delete the `data-testid="update-check-result"` paragraph and rerun. Expected: exactly that test fails. Restore.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck && npm run check-deps && npm run e2e`
Expected: all green. `check-deps` matters here: this plan adds no dependency, so it must stay clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/SettingsPane.tsx src/shared/ipc.ts src/preload/index.ts src/main/ipc/register.ts tests/e2e/update.spec.ts
git commit -m "Let Settings name the version and check on demand"
```

---

### Task 9: Publishing

The other half of the feature: without a release to find, none of the above ever fires.

**Files:**
- Create: `scripts/release.sh`
- Modify: `docs/superpowers/specs/2026-08-05-update-notifier-design.md` (record what shipped)

**Interfaces:**
- Consumes: `npm run make`, the `gh` CLI.
- Produces: `scripts/release.sh`.

**Confirm with the user before running anything in Step 3.** Creating a public repo is not reversible in the way a commit is: the code, the full history and every comment in it become public the moment it pushes.

- [ ] **Step 1: Write the script**

Create `scripts/release.sh`:

```bash
#!/usr/bin/env bash
# Cut a release: bump, build, tag, upload.
#
# Local rather than a GitHub Action. A macOS runner is free for a public repo,
# but it would add a workflow, a native-module build of node-pty on CI, and a
# slower loop, to replace a machine that is already here and already builds
# this app every day.
#
# The app is UNSIGNED. Whoever downloads the zip has to clear Gatekeeper by
# hand once, in System Settings, Privacy and Security, "Open Anyway"; on macOS
# 15 and later right-click-Open no longer does it. That is the cost of not
# holding an Apple Developer Program membership, and it is the reason there is
# no auto-apply here, only a notification.
set -euo pipefail

BUMP="${1:-patch}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

npm run typecheck
npm test

npm version "$BUMP"
VERSION="$(node -p "require('./package.json').version")"

npm run make

ZIP="out/make/zip/darwin/arm64/PRCLI-darwin-arm64-${VERSION}.zip"
if [[ ! -f "$ZIP" ]]; then
  echo "Expected build output at $ZIP but it is not there." >&2
  echo "Contents of out/make:" >&2
  find out/make -name '*.zip' >&2 || true
  exit 1
fi

git push --follow-tags
gh release create "v${VERSION}" "$ZIP" --title "v${VERSION}" --generate-notes

echo "Released v${VERSION}."
```

- [ ] **Step 2: Make it executable and dry-check the build path**

```bash
chmod +x scripts/release.sh
npm run make
find out/make -name '*.zip'
```

Expected: one zip. If its path is not `out/make/zip/darwin/arm64/PRCLI-darwin-arm64-<version>.zip`, correct the `ZIP` line in the script to the real path before going further. Do not guess: the guard in the script exists because this path is the one thing here that cannot be verified without building.

- [ ] **Step 3: Create the repo**

First, review what is about to become public. `docs/` holds every spec, plan and review in this project's history, and `src/main/hooks/` writes into the user's `~/.claude`. Read `docs/` for client names or anything else that should not ship, and check `git log` for the same.

Then, with the user's confirmation:

```bash
gh repo create paoloresteghini/PRCLI --public --source=. --push
```

- [ ] **Step 4: Cut the first release**

```bash
./scripts/release.sh minor
```

Expected: version 0.2.0, a tag, and a release carrying one zip.

- [ ] **Step 5: Verify the loop closes**

This is the only end-to-end proof that exists for the feature, and nothing automated can stand in for it.

1. Check out the tag before the release (`git stash` any work first), or edit `package.json` to `0.1.0` temporarily.
2. `npm start`.
3. Open Settings, press **Check now**. Expected: "PRCLI 0.2.0 is available".
4. Quit, unset the temporary edit, and confirm Settings now says "PRCLI is up to date".

The background bar cannot be seen this way without waiting ten seconds past launch with `PRCLI_UPDATE_CHECK` unset, which is also worth doing once.

- [ ] **Step 6: Record what shipped**

Append a short "Shipped" section to the spec at `docs/superpowers/specs/2026-08-05-update-notifier-design.md` naming: the repo URL, the first release version, whether the manual verification in Step 5 passed, and the exact build output path the script uses. Correct anything in the spec the implementation diverged from, in particular the E2E paragraph if Task 7's skip test ended up shaped differently.

- [ ] **Step 7: Commit**

```bash
git add scripts/release.sh docs/superpowers/specs/2026-08-05-update-notifier-design.md
git commit -m "Cut a release from the machine that builds it"
```

---

## Notes for the reviewer

**Two channels the spec did not anticipate.** It named three (`updateAvailable`, `checkForUpdate`, `skipUpdate`); this plan adds `openExternal` (Task 6) and `appVersion` (Task 8). Both are consequences the spec implied without naming: the renderer has neither `shell` nor `app`, so opening the release page and displaying the running version each need a trip to main. `openExternal` also carries a scheme guard the spec did not call for, because the URL it opens arrives from a network feed.

**Two e2e assertions the spec asked for that are not built as written.** The relaunch-skip test (see the note in Task 7) and the `shell.openExternal` interception (see the note on the download test). Both have a stated replacement and a stated reason. Task 9 Step 6 corrects the spec.

**What no test covers, stated plainly** so a green run is not read as more than it is:

- The scheduler in `src/main/update/schedule.ts`: both timers, the env switch and the `send`. Switched off in every e2e.
- The real network call `fetchLatestRelease`. Every unit test injects a fake; the only exercise it gets is Task 8's Settings test and Task 9 Step 5, by hand.
- Whether `Download` opens a browser. Electron does not let a spec intercept `shell.openExternal`. The scheme guard behind it is covered; the call itself is not.
- The build output path in `scripts/release.sh`, until Task 9 Step 2 runs a real `npm run make`.

**The single biggest risk** is that none of this ever fires because the feed URL names the wrong repo. That failure is silent by design: a 404 is a failed check, and a failed check shows nothing. `updateService.test.ts` pins the URL string, and Task 9 Step 5 is the only thing that proves the whole loop.
