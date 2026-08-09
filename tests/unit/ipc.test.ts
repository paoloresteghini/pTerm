import { describe, it, expect } from 'vitest'
import { columnIsCollapsed, type ColumnVisibility } from '../../src/shared/ipc'

describe('columnIsCollapsed', () => {
  it('reads an explicit false as open', () => {
    const collapsed: ColumnVisibility = {
      tabs: true,
      files: true,
      skills: true,
      presets: true,
      prompts: true,
      notes: true,
      git: false,
    }
    expect(columnIsCollapsed(collapsed, 'git')).toBe(false)
  })

  it('reads an explicit true as collapsed', () => {
    const collapsed: ColumnVisibility = {
      tabs: true,
      files: true,
      skills: true,
      presets: true,
      prompts: true,
      notes: true,
      git: true,
    }
    expect(columnIsCollapsed(collapsed, 'git')).toBe(true)
  })

  // The safety this exists for. `ColumnVisibility` says every key is present,
  // but that guarantee lives in the type only: `columnsVisible`'s payload is
  // plain JSON once it crosses `ipcMain.on`, and a key a future caller
  // forgot (a renamed column, a seventh one) arrives as `undefined` despite
  // the annotation. The cast below is exactly that: a payload the compiler
  // is told is complete but at runtime is not.
  it('reads a key missing from the actual payload as collapsed, not open', () => {
    const incomplete = { files: true, skills: true } as ColumnVisibility
    expect(columnIsCollapsed(incomplete, 'git')).toBe(true)
  })
})
