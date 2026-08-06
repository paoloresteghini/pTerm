#!/usr/bin/env node
// Checks the thing a user actually downloads, not the tree it was built from.
//
// Two shipped releases have been broken by defects that every other gate was
// structurally unable to see. The unit and E2E suites run against `src/` and
// `node_modules/`; a review reads a diff. Neither one opens the zip. Both
// defects were only reachable through the packaged bundle:
//
//   1. Packaging steps that run after the fuses plugin's ad-hoc re-sign
//      invalidated that signature, so the downloaded app was "damaged".
//      Invisible locally because Gatekeeper only enforces a signature on a
//      file carrying the quarantine attribute, which a locally built copy
//      never has.
//   2. `spawn-helper`, node-pty's extensionless helper binary, stayed inside
//      `app.asar` because the only unpack glob matched `*.node`. Every
//      session in the packaged app failed with "posix_spawnp failed."
//      Invisible in dev and E2E, which load node-pty from `node_modules`
//      where the helper is an ordinary file on disk.
//
// Both are one assertion each against an extracted zip. Usage:
//   node scripts/verify-artifact.js <path-to-zip>

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const zipPath = process.argv[2]
if (!zipPath) {
  console.error('usage: node scripts/verify-artifact.js <path-to-zip>')
  process.exit(2)
}
if (!fs.existsSync(zipPath)) {
  console.error(`No such artifact: ${zipPath}`)
  process.exit(2)
}

const failures = []
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prcli-verify-'))

function check(label, fn) {
  try {
    fn()
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL  ${label}`)
  }
}

try {
  // `ditto -xk` rather than `unzip`: it is what macOS itself uses for these
  // archives and it preserves the resource forks and modes that a signature
  // seals. `unzip` can drop them and turn a valid signature into a false
  // failure here.
  execFileSync('ditto', ['-xk', zipPath, workDir], { stdio: 'inherit' })

  const appName = fs.readdirSync(workDir).find((entry) => entry.endsWith('.app'))
  if (!appName) {
    throw new Error(`No .app inside ${zipPath}`)
  }
  const appPath = path.join(workDir, appName)
  console.log(`Verifying ${appName} extracted from ${zipPath}`)

  check('signature verifies (--deep --strict)', () => {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' })
  })

  // The exact path node-pty computes at runtime: `lib/unixTerminal.js`
  // resolves the helper next to the native module it loaded and then
  // rewrites `app.asar` to `app.asar.unpacked` in that path. If the helper
  // is not sitting right here, no pty can start.
  const unpackedRelease = path.join(
    appPath,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release',
  )

  check('node-pty native module is unpacked', () => {
    if (!fs.existsSync(path.join(unpackedRelease, 'pty.node'))) {
      throw new Error(`missing ${path.join(unpackedRelease, 'pty.node')}`)
    }
  })

  check('node-pty spawn-helper is unpacked and executable', () => {
    const helper = path.join(unpackedRelease, 'spawn-helper')
    if (!fs.existsSync(helper)) {
      throw new Error(`missing ${helper} (a packed helper fails every session with "posix_spawnp failed.")`)
    }
    if ((fs.statSync(helper).mode & 0o111) === 0) {
      throw new Error(`${helper} is not executable`)
    }
    const kind = execFileSync('file', ['-b', helper], { encoding: 'utf8' })
    if (!kind.includes('Mach-O')) {
      throw new Error(`${helper} is not a Mach-O binary: ${kind.trim()}`)
    }
  })
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} artifact check(s) failed:`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log('\nArtifact checks passed.')
