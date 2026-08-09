import { describe, expect, it } from 'vitest'
import { classify, type GhRun } from '../../src/main/gh/run'

function run(over: Partial<GhRun>): GhRun {
  return { code: 1, stdout: '', stderr: '', spawnFailed: false, ...over }
}

describe('classify', () => {
  it('reports a missing binary', () => {
    expect(classify(run({ spawnFailed: true }))).toBe('no-gh')
  })

  it('reports missing authentication', () => {
    const stderr = 'To get started with GitHub CLI, please run: gh auth login'
    expect(classify(run({ stderr }))).toBe('no-auth')
  })

  it('reports an expired or rejected token', () => {
    expect(classify(run({ stderr: 'HTTP 401: Bad credentials' }))).toBe('no-auth')
  })

  it('reports issues being disabled', () => {
    const stderr = 'GraphQL: Could not resolve to a Repository with the name o/n.'
    expect(classify(run({ stderr }))).toBe('no-issues')
  })

  it('reports an explicit issues-disabled message', () => {
    expect(classify(run({ stderr: 'the "Issues" tab is disabled' }))).toBe('no-issues')
  })

  it('falls through to a generic failure', () => {
    expect(classify(run({ stderr: 'dial tcp: lookup github.com: no such host' }))).toBe('failed')
  })

  it('does not read a successful run as a failure reason it cannot justify', () => {
    expect(classify(run({ code: 0 }))).toBe('failed')
  })
})
