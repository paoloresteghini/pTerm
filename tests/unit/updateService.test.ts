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
  readSkipped?: () => Promise<string | null>
}) =>
  createUpdateService({
    currentVersion: options.currentVersion ?? '0.1.0',
    fetchLatest: options.fetchLatest ?? (() => Promise.resolve(release('v0.2.0'))),
    readSkipped: options.readSkipped ?? (() => Promise.resolve(options.skipped ?? null)),
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

  it('never rejects, even if readSkipped throws', async () => {
    const result = await service({
      readSkipped: () => Promise.reject(new Error('disk read failed')),
    }).check()
    expect(result.status).toBe('failed')
    expect(result.message).toContain('disk read failed')
  })

  // A corrupted or migrated skip string that cannot be parsed. The `?? -1`
  // default should treat it as "not skipped" and offer the update, rather than
  // silencing it forever based on an unreadable value.
  it('offers an update when the skipped version is unparseable', async () => {
    const result = await service({
      currentVersion: '0.1.0',
      skipped: 'garbage-not-semver',
    }).check()
    expect(result.status).toBe('available')
  })

  // When a version is skipped and then a yanked release (older than the skip)
  // arrives as latest, the skip should still apply. This tests the >= 0 logic:
  // skip 0.3.0, see 0.2.0 as latest, and stay silent.
  it('stays quiet when a yanked release matches a skip', async () => {
    const result = await service({
      currentVersion: '0.1.0',
      skipped: '0.3.0',
      fetchLatest: () => Promise.resolve(release('v0.2.0')),
    }).check()
    expect(result.status).toBe('skipped')
    expect(result.info?.version).toBe('0.2.0')
  })
})
