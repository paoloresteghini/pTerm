/**
 * Which runs of text in a pane are file paths, what a click on one opens, and
 * which paths are inside the project at all.
 *
 * This file carries the weight for the path half of terminal links, for the
 * reason its sibling `terminalLinks.test.ts` gives about the url half: what
 * happens after a click is a `shell` call or an IPC round trip that an e2e
 * spec cannot observe, so the decisions live in a pure module and are proved
 * here.
 *
 * The permissiveness asserted below is deliberate and is only safe in company:
 * `findPaths` returns shapes, and `Terminal.tsx` draws a link only for the
 * ones main confirms are readable files. Tests that pin the loose cases are
 * therefore pinning a real contract, not tolerating a bug.
 */
import { describe, it, expect } from 'vitest'
import { findPaths, opensInEditor, toRelative } from '../../src/renderer/lib/terminalPaths'

describe('findPaths', () => {
  it('finds a project-relative path', () => {
    expect(findPaths('tests/e2e/tabs.spec.ts')).toEqual([
      { path: 'tests/e2e/tabs.spec.ts', start: 0, end: 22 },
    ])
  })

  it('finds a path surrounded by text, at the right offsets', () => {
    const line = 'see tests/e2e/tabs.spec.ts now'
    const [found] = findPaths(line)
    // Asserted against the line itself, not trusted as numbers: these offsets
    // become the underlined cells.
    expect(line.slice(found.start, found.end)).toBe('tests/e2e/tabs.spec.ts')
  })

  it('drops a :line suffix from the path and from the underline', () => {
    const line = 'src/renderer/App.tsx:2284'
    const [found] = findPaths(line)
    expect(found.path).toBe('src/renderer/App.tsx')
    // The end stops before the colon, so `:2284` is not underlined. Nothing
    // downstream can scroll to a line, and underlining it would say otherwise.
    expect(line.slice(found.start, found.end)).toBe('src/renderer/App.tsx')
  })

  it('drops a :line:col suffix too', () => {
    expect(findPaths('src/main/index.ts:12:34').map((f) => f.path)).toEqual(['src/main/index.ts'])
  })

  it('finds an absolute path', () => {
    expect(findPaths('/Users/x/Code/p/src/a.ts').map((f) => f.path)).toEqual([
      '/Users/x/Code/p/src/a.ts',
    ])
  })

  it('finds a bare filename with an extension', () => {
    expect(findPaths('edit tabs.spec.ts first').map((f) => f.path)).toEqual(['tabs.spec.ts'])
  })

  it('finds several on one line', () => {
    expect(findPaths('a src/one.ts and src/two.ts').map((f) => f.path)).toEqual([
      'src/one.ts',
      'src/two.ts',
    ])
  })

  it('trims a trailing sentence mark but keeps the extension', () => {
    expect(findPaths('open src/App.tsx.').map((f) => f.path)).toEqual(['src/App.tsx'])
  })

  it('trims the wrapping punctuation a path is quoted with', () => {
    expect(findPaths('`src/App.tsx`').map((f) => f.path)).toEqual(['src/App.tsx'])
    expect(findPaths('(src/App.tsx)').map((f) => f.path)).toEqual(['src/App.tsx'])
    expect(findPaths('"src/App.tsx"').map((f) => f.path)).toEqual(['src/App.tsx'])
  })

  it('ignores a url, which the other provider already offers', () => {
    // Two providers underlining the same cells is a link whose behaviour
    // depends on which one xterm asked first.
    expect(findPaths('https://example.com/a/b.ts')).toEqual([])
  })

  it('ignores a command-line option', () => {
    expect(findPaths('--reporter=line')).toEqual([])
  })

  it('ignores a plain word', () => {
    expect(findPaths('open the file now')).toEqual([])
  })

  it('ignores a lone separator', () => {
    expect(findPaths('a / b')).toEqual([])
    expect(findPaths('///')).toEqual([])
  })

  it('returns prose that merely looks like a path, for the probe to reject', () => {
    // Pinned rather than tolerated: the module is permissive on purpose and
    // main's existence check is what stops this becoming a link. A change that
    // made this return nothing would be tightening the wrong half.
    expect(findPaths('e.g the file').map((f) => f.path)).toEqual(['e.g'])
  })
})

describe('opensInEditor', () => {
  it('opens source files in the editor', () => {
    for (const path of ['src/App.tsx', 'a/b.ts', 'README.md', 'x.json', 'y.txt']) {
      expect(opensInEditor(path)).toBe(true)
    }
  })

  it('sends images, archives and binaries to the system opener', () => {
    for (const path of ['shot.png', 'a/b.PNG', 'doc.pdf', 'x.zip', 'f.woff2', 'app.dylib']) {
      expect(opensInEditor(path)).toBe(false)
    }
  })

  it('treats a file with no extension as text', () => {
    // Right for a shell script, wrong for a stripped binary. The wrong case is
    // recoverable by closing the pane; the reverse sends a readable file away.
    expect(opensInEditor('scripts/build')).toBe(true)
    expect(opensInEditor('Makefile')).toBe(true)
  })

  it('does not read a directory name as the extension', () => {
    // The dot is in the directory, not the file, so there is no extension to
    // look up and `png` must not be found by scanning the whole string.
    expect(opensInEditor('a.png/notes')).toBe(true)
  })

  it('reads a dotfile as having no extension', () => {
    expect(opensInEditor('.gitignore')).toBe(true)
    expect(opensInEditor('a/.env')).toBe(true)
  })
})

describe('toRelative', () => {
  const cwd = '/Users/x/Code/p'

  it('passes a relative path through', () => {
    expect(toRelative('src/App.tsx', cwd)).toBe('src/App.tsx')
  })

  it('strips a leading ./', () => {
    expect(toRelative('./src/App.tsx', cwd)).toBe('src/App.tsx')
  })

  it('makes an absolute path inside the project relative', () => {
    expect(toRelative('/Users/x/Code/p/src/App.tsx', cwd)).toBe('src/App.tsx')
  })

  it('refuses an absolute path outside the project', () => {
    // The scope decision in one assertion: a path elsewhere on disk never
    // becomes a link, rather than becoming one that fails when clicked.
    expect(toRelative('/private/tmp/shot.png', cwd)).toBeNull()
  })

  it('refuses a sibling directory that shares the prefix', () => {
    // `/Users/x/Code/pp` starts with `/Users/x/Code/p`, and is not inside it.
    // The separator in the comparison is what makes this null.
    expect(toRelative('/Users/x/Code/pp/a.ts', cwd)).toBeNull()
  })

  it('tolerates a trailing separator on the project cwd', () => {
    // `config.json` is hand-editable, and `resolveInside` documents the same
    // hazard for its own root.
    expect(toRelative('/Users/x/Code/p/src/App.tsx', '/Users/x/Code/p/')).toBe('src/App.tsx')
  })

  it('refuses a relative path that climbs out', () => {
    expect(toRelative('../other/a.ts', cwd)).toBeNull()
    expect(toRelative('src/../../a.ts', cwd)).toBeNull()
  })

  it('refuses the project root itself', () => {
    expect(toRelative('.', cwd)).toBeNull()
  })
})
