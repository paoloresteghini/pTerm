import { describe, expect, it } from 'vitest'
import { MARKER_END, MARKER_START, block, isInstalled, merge, unmerge } from '../../src/main/shell/install'

const script = '/Users/x/.prcli/bin/prcli-history.zsh'

describe('the zshrc block', () => {
  it('is bounded by markers so uninstall can be exact', () => {
    expect(block(script).startsWith(MARKER_START)).toBe(true)
    expect(block(script).trimEnd().endsWith(MARKER_END)).toBe(true)
    expect(block(script)).toContain(script)
  })

  it('reports not installed for an rc that has never seen it', () => {
    expect(isInstalled('export PATH=/usr/bin\n')).toBe(false)
  })

  it('appends the block, preserving what was already there', () => {
    const merged = merge('export PATH=/usr/bin\n', script)
    expect(merged.startsWith('export PATH=/usr/bin\n')).toBe(true)
    expect(isInstalled(merged)).toBe(true)
  })

  // Installing twice must not leave two blocks: the hook would then be
  // registered twice and every command recorded twice.
  it('is idempotent', () => {
    const once = merge('export PATH=/usr/bin\n', script)
    const twice = merge(once, script)
    expect(twice).toBe(once)
    expect(twice.split(MARKER_START)).toHaveLength(2)
  })

  it('removes exactly what it added', () => {
    const original = 'export PATH=/usr/bin\nalias g=git\n'
    expect(unmerge(merge(original, script))).toBe(original)
  })

  it('leaves an rc it never touched alone', () => {
    const original = 'export PATH=/usr/bin\n'
    expect(unmerge(original)).toBe(original)
  })

  // The round trip above only proves itself for an rc that already ends in a
  // newline. A dotfile with no trailing newline takes a different branch
  // through merge's separator logic, and is the case that first exposed
  // unmerge stripping the wrong newline (see install.ts's comments on merge
  // and unmerge for why the separator has to be unconditional).
  it('removes exactly what it added, for an rc with no trailing newline', () => {
    const original = 'export PATH=/usr/bin'
    expect(unmerge(merge(original, script))).toBe(original)
  })

  // An empty rc is the other edge merge's `rc === ''` branch treats
  // specially: no separator at all, so the round trip must land back on
  // the empty string, not a stray leftover newline.
  it('removes exactly what it added, for an empty rc', () => {
    expect(unmerge(merge('', script))).toBe('')
  })
})
