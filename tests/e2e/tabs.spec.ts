import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-tabs'

let userDataDir: string
let configDir: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PRCLI_CONFIG_DIR: configDir, PRCLI_TMUX_SOCKET: SOCKET },
  })
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

async function sessionNames(): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-tabs-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-tabs-config-'))
})

test.afterEach(async () => {
  await killServer()
  await rm(userDataDir, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
})

test('a second instance exits instead of opening its own session', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal')).toBeVisible()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)

  // A second launch must not create a second session. electron.launch() itself
  // can reject when the app quits before opening a window, which is exactly
  // the behaviour under test, so a rejection counts as "exited" too.
  let secondStatus: 'exited' | 'still running'
  let second: ElectronApplication | null = null
  try {
    second = await launch()
    secondStatus = await second.evaluate(({ app }) => app.getVersion()).then(
      () => 'still running' as const,
      () => 'exited' as const,
    )
  } catch {
    secondStatus = 'exited'
  }
  expect(secondStatus).toBe('exited')
  if (second && secondStatus === 'still running') {
    await second.close()
  }

  await expect.poll(async () => (await sessionNames()).length, { timeout: 10_000 }).toBe(1)

  await first.close()
})
