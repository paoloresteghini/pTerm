#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.PTERM_GH_STUB_LOG
if (log) appendFileSync(log, JSON.stringify(args) + '\n')

// Stalls before answering anything, failures included, so a spec can look at
// what the column shows while a call is in flight. `Atomics.wait` on a
// throwaway buffer rather than a timer: this stub writes its reply and exits
// straight afterwards, and blocking the one thread is the whole intent.
const delay = Number(process.env.PTERM_GH_STUB_DELAY_MS ?? '0')
if (delay > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
}

const mode = process.env.PTERM_GH_STUB_MODE ?? 'ok'
if (mode === 'no-auth') {
  process.stderr.write('To get started with GitHub CLI, please run: gh auth login\n')
  process.exit(4)
}
if (mode === 'no-issues') {
  process.stderr.write('GraphQL: Could not resolve to a Repository with the name o/n.\n')
  process.exit(1)
}

const fixture = process.env.PTERM_GH_STUB_FIXTURE
if (fixture) {
  process.stdout.write(readFileSync(fixture, 'utf8'))
} else {
  process.stdout.write('[]')
}
process.exit(0)
