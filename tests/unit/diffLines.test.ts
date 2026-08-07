import { describe, expect, it } from 'vitest'
import { classifyDiffLines } from '../../src/renderer/lib/diffLines'

describe('classifyDiffLines', () => {
  it('reads +++/--- as headers before the first hunk', () => {
    const text = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-one', '+two'].join(
      '\n',
    )
    expect(classifyDiffLines(text).map((row) => row.kind)).toEqual([
      'header',
      'header',
      'header',
      'hunk',
      'remove',
      'add',
    ])
  })

  // The bug this test was written for: a removed line's own content can
  // start with `-`, and a bare prefix match on `---` reads it as a file
  // header instead of a removal. Classification must be positional, not
  // content-based, once inside a hunk.
  it('classifies a removed line that itself starts with --- as removed, not a header', () => {
    const text = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,1 +0,0 @@',
      '--- a markdown rule',
    ].join('\n')
    const rows = classifyDiffLines(text)
    expect(rows[rows.length - 1]).toEqual({ line: '--- a markdown rule', kind: 'remove' })
  })

  // Symmetric case for an added line beginning with +.
  it('classifies an added line that itself starts with +++ as added, not a header', () => {
    const text = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -0,0 +1,1 @@',
      '+++ this line was added',
    ].join('\n')
    const rows = classifyDiffLines(text)
    expect(rows[rows.length - 1]).toEqual({ line: '+++ this line was added', kind: 'add' })
  })

  it('resets the header window on the next diff --git, for a combined diff of several files', () => {
    const text = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+two',
      'diff --git a/y b/y',
      '--- a/y',
      '+++ b/y',
      '@@ -1,1 +1,1 @@',
      '-three',
      '+four',
    ].join('\n')
    expect(classifyDiffLines(text).map((row) => row.kind)).toEqual([
      'header',
      'header',
      'header',
      'hunk',
      'remove',
      'add',
      'header',
      'header',
      'header',
      'hunk',
      'remove',
      'add',
    ])
  })

  it('classifies an unchanged context line as context', () => {
    const text = ['diff --git a/x b/x', '@@ -1,1 +1,1 @@', ' unchanged'].join('\n')
    const rows = classifyDiffLines(text)
    expect(rows[rows.length - 1]).toEqual({ line: ' unchanged', kind: 'context' })
  })
})
