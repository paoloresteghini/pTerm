import { describe, it, expect } from 'vitest'
import { partitionFor } from '../../src/renderer/BrowserPane'
import { UNSORTED_ID } from '../../src/shared/ipc'

describe('partitionFor', () => {
  it('names a real project a partition of its own', () => {
    expect(partitionFor('abc123')).toBe('persist:proj-abc123')
  })

  it('maps the synthetic Unsorted id to one fixed partition rather than embedding it', () => {
    expect(partitionFor(UNSORTED_ID)).toBe('persist:proj-unsorted')
  })
})
