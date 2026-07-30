import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

let userDataDir: string
let configDir: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    // Keep the app's config out of the real ~/.prcli during tests.
    env: { ...process.env, PRCLI_CONFIG_DIR: configDir },
  })
}

/** Kill every prcli session this test created, on the default tmux socket. */
async function cleanupSessions(): Promise<void> {
  let stdout = ''
  try {
    ;({ stdout } = await run('tmux', ['list-sessions', '-F', '#{session_name}']))
  } catch {
    return
  }
  for (const name of stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (name.startsWith('prcli-scratch-')) {
      await run('tmux', ['kill-session', '-t', `=${name}`]).catch(() => undefined)
    }
  }
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

// Both tests in this file share one config dir on purpose — the second test
// depends on the first launch's persisted tabs to prove reattachment.
test.beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-config-'))
})

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-'))
})

test.afterEach(async () => {
  await cleanupSessions()
  await rm(userDataDir, { recursive: true, force: true })
})

test.afterAll(async () => {
  await rm(configDir, { recursive: true, force: true })
})

test('renders a terminal and echoes typed input', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  const terminal = window.getByTestId('terminal')
  await expect(terminal).toBeVisible()

  // Click first so xterm's hidden textarea has focus before typing.
  await terminal.click()
  await window.keyboard.type('echo e2e-marker')
  await window.keyboard.press('Enter')

  await expect(window.locator('.xterm-rows')).toContainText('e2e-marker', { timeout: 20_000 })
  await app.close()
})

test('reattaches the same session with scrollback after relaunch', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal')).toBeVisible()
  await firstWindow.getByTestId('terminal').click()
  await firstWindow.keyboard.type('echo survives-restart')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.locator('.xterm-rows')).toContainText('survives-restart', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('.xterm-rows')).toContainText('survives-restart', {
    timeout: 20_000,
  })
  await second.close()
})
