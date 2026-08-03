import { describe, it, expect } from 'vitest'
import { frontmatter } from '../../src/main/skills/frontmatter'

/**
 * The four shapes that actually occur, counted across the 73 skills and 36
 * commands on the target machine rather than imagined: 57 plain values, 14
 * quoted, 2 folded block scalars, and one file with no `name:` at all.
 */
describe('frontmatter', () => {
  it('reads a plain scalar', () => {
    const fields = frontmatter('---\nname: browse\ndescription: Fast browser.\n---\nbody')
    expect(fields.name).toBe('browse')
    expect(fields.description).toBe('Fast browser.')
  })

  it('strips matching quotes', () => {
    const fields = frontmatter('---\nname: "a"\ndescription: \'b\'\n---\n')
    expect(fields.name).toBe('a')
    expect(fields.description).toBe('b')
  })

  it('folds a block scalar onto one line', () => {
    // The shape `brand-voice-enforcement` and `ogilvy-copywriting` use. A
    // parser that only reads the value on the key's own line reports these
    // two as having no description at all.
    const text = '---\nname: ogilvy\ndescription: >\n  First part\n  second part\nother: x\n---\n'
    expect(frontmatter(text).description).toBe('First part second part')
  })

  it('keeps reading keys after a block scalar', () => {
    // Asserts the folded value AND the key after it, because asserting only
    // the later key passes with the fold branch deleted — the indentation
    // guard skips the continuation lines either way.
    const text = '---\ndescription: |\n  one\n  two\nname: kept\n---\n'
    expect(frontmatter(text)).toEqual({ description: 'one two', name: 'kept' })
  })

  it('returns nothing for a file with no frontmatter', () => {
    expect(frontmatter('# Just a heading\n')).toEqual({})
  })

  it('returns nothing when the frontmatter is never closed', () => {
    expect(frontmatter('---\nname: unterminated\n')).toEqual({})
  })

  it('ignores nested keys rather than flattening them', () => {
    // An indented line must never be mistaken for a top-level field. The
    // nested entry needs a COLON to pin this: an indented `- Read` is already
    // skipped by the no-colon check further down, so a list-only fixture
    // passes with the indentation guard removed entirely.
    //
    // 13 real files nest a `key: value` in frontmatter — `schema: 1` under a
    // metadata block, `author: laravel`, and a deeply indented
    // `command: "bash …"` in three gstack skills. Flattening those would
    // invent top-level fields the file never declared.
    const text = '---\nname: n\nmetadata:\n  schema: 1\nallowed-tools:\n  - Read\n---\n'
    expect(frontmatter(text)).toEqual({ name: 'n', metadata: '', 'allowed-tools': '' })
  })
})
