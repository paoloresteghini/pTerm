#!/usr/bin/env node
// npm's tarball extraction drops the executable bit on node-pty's helper
// binary. Without it, every spawned pty fails at posix_spawnp() and the
// entire tmux/PTY integration suite (51 tests) fails with the same
// "posix_spawnp failed" error, which looks like a broken build rather
// than a missing chmod. Restore it after every install.
//
// Guarded to be a no-op (and never fail `npm install`) when node_modules
// isn't there yet, when node-pty didn't get installed, or on a platform
// that never had this prebuild in the first place — this repo is macOS
// only, so only the two macOS prebuild directories are touched.

const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const helperPaths = [
  path.join(rootDir, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
  path.join(rootDir, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'),
]

for (const helperPath of helperPaths) {
  try {
    if (fs.existsSync(helperPath)) {
      fs.chmodSync(helperPath, 0o755)
    }
  } catch {
    // Never fail the install over this; worst case the integration suite
    // reports the original posix_spawnp error and a human chmods it.
  }
}
