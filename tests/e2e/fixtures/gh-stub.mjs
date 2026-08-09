#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.PTERM_GH_STUB_LOG
if (log) appendFileSync(log, JSON.stringify(args) + '\n')

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
