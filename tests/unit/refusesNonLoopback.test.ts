import { describe, it, expect } from 'vitest'
import { refusesNonLoopback } from '../../src/main/ipc/register'

/**
 * The one part of the loopback confinement that is reachable without an
 * Electron host: its answer for a guest nothing has reported.
 *
 * What this file CANNOT reach, said plainly rather than left to look like
 * coverage: the map `refusesNonLoopback` reads is filled by the
 * `browserGuestAttached` handler inside `registerIpc`, which needs a real
 * `webContents`, so there is no way from here to ask about a guest that IS
 * known, owned or not. Those cases are `tests/e2e/browserMcp.spec.ts`, which
 * drives real navigations in a real pane, and the mutation record in this
 * task's report is against that file rather than this one.
 *
 * What is worth pinning here is the default. Every `<webview>` in this app is
 * a browser pane, but the function is asked about a `webContents` id from
 * `setWindowOpenHandler` (`main/index.ts`), which fires for guests this
 * process may never have been told about, and answering "confined" there
 * would refuse popups in panes nobody owns.
 */
describe('refusesNonLoopback', () => {
  it('does not confine a guest that was never reported, whatever the URL', () => {
    // An id no guest can hold: `webContents` ids are positive.
    expect(refusesNonLoopback(-1, 'https://example.com/')).toBe(false)
    expect(refusesNonLoopback(-1, 'http://localhost:3000/')).toBe(false)
  })
})
