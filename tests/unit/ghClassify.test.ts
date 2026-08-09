import { describe, expect, it } from 'vitest'
import { classify, gh, type GhRun } from '../../src/main/gh/run'

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

  it('prioritizes no-auth over no-issues when both cues are present', () => {
    const stderr = 'HTTP 401: Bad credentials. Could not resolve to a Repository.'
    expect(classify(run({ stderr }))).toBe('no-auth')
  })

  it('reports missing repository with real gh error message', () => {
    const stderr = "GraphQL: Could not resolve to a Repository with the name 'owner/name'. (repository)"
    expect(classify(run({ stderr }))).toBe('no-issues')
  })

  it('reports invalid token with real gh error message', () => {
    const stderr = `HTTP 401: Bad credentials (https://api.github.com/graphql)
Try authenticating with:  gh auth login -h github.com`
    expect(classify(run({ stderr }))).toBe('no-auth')
  })

  it('detects spawn failure when gh binary does not exist', async () => {
    const originalBin = process.env.PTERM_GH_BIN
    try {
      process.env.PTERM_GH_BIN = '/nonexistent/path/to/gh'
      const result = await gh(process.cwd(), ['--version'])
      expect(result.spawnFailed).toBe(true)
      expect(classify(result)).toBe('no-gh')
    } finally {
      if (originalBin === undefined) {
        delete process.env.PTERM_GH_BIN
      } else {
        process.env.PTERM_GH_BIN = originalBin
      }
    }
  })
})
