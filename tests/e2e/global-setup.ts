import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Build once per run, not once per spec file.
 *
 * Until 2026-08-02 each of the four specs packaged the app in its own
 * `beforeAll`, so a full run built it four times. Measured that day: one
 * `npm run package` on this machine takes ~4s, and the whole suite took 51.0s;
 * moving it here is the difference between one build and four.
 *
 * This rewrites `.vite/build/main.js` and `.vite/renderer/`. If a dev build
 * (`npm start`) is running, its main bundle — which has the Vite dev server URL
 * baked in — is replaced by a production one under it. The running process has
 * already loaded it and is unharmed, but the next `npm start` rebuilds from
 * scratch. (Measured 2026-08-01, recorded in this plan's brief and not
 * re-measured here: the dev bundle carried `http://localhost:5174`; after
 * `npm run package` it did not.)
 */
export default async function globalSetup(): Promise<void> {
  // `execFile` buffers the whole of forge's output and kills the child with
  // ENOBUFS past `maxBuffer`. A successful package prints 1,167 bytes
  // (measured 2026-08-02), so the 1 MB default is not the constraint here —
  // the headroom is so that a *failing* build's output, which is the only
  // reason to read this stream at all, arrives whole rather than truncated
  // into an ENOBUFS with the real error missing.
  await run('npm', ['run', 'package'], { maxBuffer: 32 * 1024 * 1024 })
}
