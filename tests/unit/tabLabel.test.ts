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
