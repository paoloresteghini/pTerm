import { describe, expect, it } from 'vitest'
import { parseStatus } from '../../src/main/git/status'

/**
 * Fields are NUL-separated in `-z` mode, so these fixtures join with `\0`.
 * Real output ends with a trailing NUL, which the trailing '' here reproduces.
 */
const z = (...fields: string[]): string => `${fields.join('\0')}\0`

const ORDINARY = '1 .M N... 100644 100644 100644 aaaa bbbb src/renderer/Terminal.tsx'

/**
 * A rename's original path, deliberately shaped like an untracked entry
 * ('? '-prefixed) rather than a plain 'old.ts'.
 *
 * The parser's skip past this field is what stops it being read as an entry
 * of its own. A plain 'old.ts' fixture cannot catch a regression of that
 * skip: read as its own entry, 'old.ts' starts with 'o', which matches none
 * of the recognised markers and is silently `continue`d, so the two tests
 * below passed unchanged with the skip deleted. This value fails loudly
 * instead: read as its own entry it takes the `? ` branch and adds a
 * spurious row to `unstaged`, which the assertions below can see. Measured
 * by deleting the skip in status.ts and watching both tests go red.
 */
const RENAME_FROM = '? old.ts'

describe('parseStatus', () => {
  it('reads the branch and head from the header', () => {
    const changes = parseStatus(z('# branch.oid abc123', '# branch.head master'))
    expect(changes.branch).toBe('master')
    expect(changes.head).toBe('abc123')
  })

  it('reports a detached head as no branch', () => {
    const changes = parseStatus(z('# branch.oid abc123', '# branch.head (detached)'))
    expect(changes.branch).toBeNull()
  })

  it('reports an unborn branch as no head', () => {
    const changes = parseStatus(z('# branch.oid (initial)', '# branch.head main'))
    expect(changes.head).toBeNull()
    expect(changes.branch).toBe('main')
  })

  it('puts a worktree-only change in unstaged and nowhere else', () => {
    const changes = parseStatus(z(ORDINARY))
    expect(changes.staged).toEqual([])
    expect(changes.unstaged).toEqual([
      { path: 'src/renderer/Terminal.tsx', staged: null, worktree: 'M' },
    ])
  })

  it('puts an index-only change in staged and nowhere else', () => {
    const changes = parseStatus(z('1 M. N... 100644 100644 100644 aaaa bbbb one.ts'))
    expect(changes.unstaged).toEqual([])
    expect(changes.staged).toEqual([{ path: 'one.ts', staged: 'M', worktree: null }])
  })

  // The case a single-list model gets wrong, and the reason there are two.
  it('lists a path changed on both sides in both lists', () => {
    const changes = parseStatus(z('1 MM N... 100644 100644 100644 aaaa bbbb both.ts'))
    expect(changes.staged).toEqual([{ path: 'both.ts', staged: 'M', worktree: null }])
    expect(changes.unstaged).toEqual([{ path: 'both.ts', staged: null, worktree: 'M' }])
  })

  it('reads an untracked file', () => {
    const changes = parseStatus(z('? .pterm.json'))
    expect(changes.unstaged).toEqual([{ path: '.pterm.json', staged: null, worktree: '?' }])
    expect(changes.staged).toEqual([])
  })

  it('ignores an ignored file', () => {
    const changes = parseStatus(z('! node_modules/x.js'))
    expect(changes.unstaged).toEqual([])
    expect(changes.staged).toEqual([])
  })

  // `-z` leaves paths unquoted, so a space is an ordinary character in the
  // path and must not be read as a field separator.
  it('keeps a space in a path', () => {
    const changes = parseStatus(z('1 .M N... 100644 100644 100644 aaaa bbbb my notes.md'))
    expect(changes.unstaged[0].path).toBe('my notes.md')
  })

  // A rename's original path is its own NUL-separated field, following the
  // entry, not part of it.
  it('reads a rename and its original path', () => {
    const changes = parseStatus(
      z('2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts', RENAME_FROM),
    )
    expect(changes.staged).toEqual([
      { path: 'new.ts', staged: 'R', worktree: null, renamedFrom: RENAME_FROM },
    ])
    expect(changes.unstaged).toEqual([])
  })

  it('does not mistake a rename original for an entry of its own', () => {
    const changes = parseStatus(
      z('2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts', RENAME_FROM, ORDINARY),
    )
    expect(changes.staged).toHaveLength(1)
    expect(changes.unstaged).toEqual([
      { path: 'src/renderer/Terminal.tsx', staged: null, worktree: 'M' },
    ])
  })

  it('reports an unmerged path as an unstaged U', () => {
    const changes = parseStatus(
      z('u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts'),
    )
    expect(changes.unstaged).toEqual([{ path: 'conflict.ts', staged: null, worktree: 'U' }])
    expect(changes.staged).toEqual([])
  })

  it('reads empty output as a clean tree', () => {
    const changes = parseStatus('')
    expect(changes).toEqual({ branch: null, head: null, staged: [], unstaged: [] })
  })
})
