import { describe, it, expect } from 'vitest'
import { attachSavedFields } from '../../src/main/ipc/savedFields'
import type { PaneRecord } from '../../src/main/sessions/manager'
import type { TabDescriptor } from '../../src/shared/ipc'

/**
 * `attachSavedFields`, called directly, and only for `filePath`.
 *
 * Not a full specification of the function: `title` and `color` are covered by
 * `splits.spec.ts`'s `right-clicking a pane recolours it … and it survives a
 * relaunch`, whose own header records the mutation that proves it. This file
 * exists because `filePath` had no such witness. Measured 2026-08-04, deleting
 * the `filePath` line left all three tests of `editorRestore.spec.ts` passing,
 * because `mergeSessionlessPanes` hands this function the SAVED record for an
 * editor pane, file path already on it, leaving nothing to reattach.
 *
 * **Direct, and that is the whole point.** The same assertion made through
 * `restoreWorkspace` would pass with the line deleted, for exactly the reason
 * above: it would be a test of the merge wearing this function's name. What
 * makes this one discriminate is the input: a pane record that does NOT carry
 * the field, which is what any future manager-built editor pane would be.
 */
describe('attachSavedFields', () => {
  it('puts a saved filePath onto a record that does not carry one', () => {
    // No `filePath`, which is every record `manager.open()` builds: it deals in
    // tmux, and the file an editor shows is config's alone.
    const built: TabDescriptor[] = [
      { id: 'e1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'editor' },
    ]
    const saved: PaneRecord[] = [
      { id: 'e1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'editor', filePath: '/tmp/demo/a.ts' },
    ]

    expect(attachSavedFields(built, saved)[0]?.filePath).toBe('/tmp/demo/a.ts')
  })

  it('carries diffSide from the saved row', () => {
    const built: TabDescriptor[] = [
      { id: 'd1', projectSlug: 'demo', cwd: '/tmp/demo', type: 'diff' },
    ]
    const saved: PaneRecord[] = [
      {
        id: 'd1',
        projectSlug: 'demo',
        cwd: '/tmp/demo',
        type: 'diff',
        diffSide: 'staged',
      },
    ]

    expect(attachSavedFields(built, saved)[0]?.diffSide).toBe('staged')
  })
})
