import { describe, it, expect } from 'vitest'
import { tabLabel } from '../../src/renderer/lib/tabLabel'
import type { TabDescriptor } from '../../src/shared/ipc'

function tab(id: string, projectSlug = 'lumio'): TabDescriptor {
  return {
    id,
    projectSlug,
    cwd: '/tmp',
    tmuxSession: `prcli-${projectSlug}-${id}`,
    type: 'shell',
  }
}

describe('tabLabel', () => {
  it('falls back to the project slug and a slice of the id', () => {
    expect(tabLabel(tab('a'.repeat(16), 'lumio'))).toBe('lumio · aaaaaa')
  })

  it('uses the title once there is one', () => {
    expect(tabLabel({ ...tab('a'.repeat(16), 'lumio'), title: 'payments api' })).toBe('payments api')
  })

  // How a name is cleared: the renderer sends '' and the store drops the
  // field, but a config edited by hand can still hold one, and an empty tab
  // is unclickable and unreadable.
  it('falls back when the title is an empty string', () => {
    expect(tabLabel({ ...tab('a'.repeat(16), 'lumio'), title: '' })).toBe('lumio · aaaaaa')
  })
})

const editor = (over: Partial<TabDescriptor> = {}): TabDescriptor =>
  ({
    id: 'abcdef123456',
    projectSlug: 'demo',
    cwd: '/tmp/demo',
    type: 'editor',
    filePath: '/tmp/demo/src/main.ts',
    ...over,
  }) as TabDescriptor

describe('tabLabel, for an editor pane', () => {
  it('names it for the file, not the slug and id', () => {
    expect(tabLabel(editor())).toBe('main.ts')
  })

  // A user-set title still wins, exactly as it does for a terminal. This is
  // the reason the editor case goes through this function rather than being
  // special-cased at each of the four call sites.
  it('still prefers a title the user set', () => {
    expect(tabLabel(editor({ title: 'the parser' }))).toBe('the parser')
  })

  // An editor pane whose file could not be read has no filePath (Task 1
  // drops a malformed one). It must not render as an empty tab.
  it('falls back to the slug and id when there is no file', () => {
    expect(tabLabel(editor({ filePath: undefined }))).toBe('demo · abcdef')
  })

  // A trailing separator still leaves a last non-empty segment, so it names
  // the tab for the directory. A bare '/' has none, and must not render as
  // an empty tab: it falls back to the slug and id like a missing file does.
  it('never returns an empty string', () => {
    expect(tabLabel(editor({ filePath: '/tmp/demo/' }))).toBe('demo')
    expect(tabLabel(editor({ filePath: '/' }))).toBe('demo · abcdef')
  })
})
