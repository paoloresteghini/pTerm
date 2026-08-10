import { describe, expect, it } from 'vitest'
import { issueArgs } from '../../src/main/gh/issues'

describe('issueArgs', () => {
  it('closes with a completed reason', () => {
    expect(issueArgs('close', 42, 'o/n', 'completed')).toEqual([
      'issue', 'close', '42', '--repo', 'o/n', '--reason', 'completed',
    ])
  })

  it('passes "not planned" as one unquoted argv element', () => {
    const args = issueArgs('close', 42, 'o/n', 'not planned')
    expect(args).toContain('not planned')
    expect(args.some((arg) => arg.includes('"') || arg.includes("'"))).toBe(false)
  })

  it('omits the reason when reopening', () => {
    expect(issueArgs('reopen', 42, 'o/n')).toEqual(['issue', 'reopen', '42', '--repo', 'o/n'])
  })

  it('never omits --repo', () => {
    expect(issueArgs('close', 1, 'gh.corp/o/n')).toContain('--repo')
    expect(issueArgs('reopen', 1, 'gh.corp/o/n')).toContain('gh.corp/o/n')
  })
})
