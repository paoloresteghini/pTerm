#!/usr/bin/env node
// Fails the build if a runtime dependency in package.json's "dependencies"
// is imported nowhere under src/. This is the concrete check that would
// have caught lucide-react sitting in the tree unused: no toolchain, no
// new devDependency, just a text scan.
//
// devDependencies are out of scope on purpose — build tooling (Vite,
// Electron Forge, TypeScript, Vitest, ...) is legitimately invoked from
// config files and npm scripts rather than imported from src/, and
// tracking that would just mean maintaining a much longer allowlist for
// no real benefit.

const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

// Dependencies that are real runtime dependencies but are never imported
// from src/ because something other than application code consumes them
// (the build pipeline, Electron Forge, etc). Empty today: every package
// currently under "dependencies" is imported somewhere in src/. Kept as a
// named, commented allowlist rather than deleted so the next legitimate
// case (e.g. a dependency only referenced from forge.config.ts) has
// somewhere honest to go instead of the check being silenced or lying.
const ALLOWLIST = new Set([
  // (none currently)
])

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function collectFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectFiles(full))
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  const dependencies = Object.keys(pkg.dependencies ?? {})

  const files = collectFiles(srcDir)
  const contents = files.map((f) => fs.readFileSync(f, 'utf8'))

  const unused = []
  for (const dep of dependencies) {
    if (ALLOWLIST.has(dep)) continue

    // Matches `'<dep>'`, `"<dep>"`, or a subpath import like
    // `'<dep>/client'` / `"<dep>/css/xterm.css"`.
    const pattern = new RegExp(`['"]${escapeRegExp(dep)}(?:/[^'"]*)?['"]`)
    const isUsed = contents.some((content) => pattern.test(content))
    if (!isUsed) unused.push(dep)
  }

  if (unused.length > 0) {
    console.error('Dependencies declared in package.json but imported nowhere under src/:')
    for (const dep of unused) console.error(`  - ${dep}`)
    console.error('')
    console.error('Either remove the dependency (npm rm <name>) or, if it is genuinely')
    console.error('consumed outside src/ (build tooling, Electron Forge, ...), add it to')
    console.error('the ALLOWLIST in scripts/check-unused-deps.js with a comment saying why.')
    process.exit(1)
  }

  console.log(`check-unused-deps: all ${dependencies.length} dependencies are imported under src/.`)
}

main()
