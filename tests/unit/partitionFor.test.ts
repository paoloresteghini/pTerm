import { describe, it, expect } from 'vitest'
import { partitionFor } from '../../src/renderer/BrowserPane'
import { UNSORTED_ID } from '../../src/shared/ipc'

describe('partitionFor', () => {
  it('names a real project a partition of its own', () => {
    expect(partitionFor('abc123')).toBe('persist:proj-abc123')
  })

  // `UNSORTED_ID` is currently `'unsorted'`, so this pins the partition name
  // against a future change to that value rather than discriminating a case
  // the plain `persist:proj-${projectId}` fold wouldn't already handle: this
  // assertion is byte-identical to the one above with `UNSORTED_ID` in place
  // of `'abc123'`, and stays passing even if `partitionFor`'s special case
  // were deleted outright.
  it('pins the Unsorted partition name against a future change to UNSORTED_ID', () => {
    expect(partitionFor(UNSORTED_ID)).toBe('persist:proj-unsorted')
  })
})
