import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

// The app runs against its own tmux server here. Nothing these tests create
// is visible on the user's default socket, and nothing they clean up can
// reach the user's real sessions.
const SOCKET = 'prcli-e2e'

let userDataDir: string
let configDir: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Keep the app's config out of the real ~/.prcli during tests.
      PRCLI_CONFIG_DIR: configDir,
      PRCLI_TMUX_SOCKET: SOCKET,
    },
  })
}

/** Destroy the test tmux server, taking every session this file created with it. */
async function killServer(): Promise<void> {
  await run('tmux', ['-L', SOCKET, 'kill-server']).catch(() => undefined)
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

// A config dir per test: the launches within a test share it, which is what
// proves reattachment, while the tests stay independent of one another.
test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-config-'))
})

test.afterEach(async () => {
  await killServer()
  await rm(userDataDir, { recursive: true, force: true })
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

// On macOS the app survives its window. Reopening must reattach the session
// that is still running, not silently replace it with a fresh one and leak
// the original.
test('reattaches the same session after closing and reopening the window', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal')).toBeVisible()
  await window.getByTestId('terminal').click()
  await window.keyboard.type('echo survives-window-close')
  await window.keyboard.press('Enter')
  await expect(window.locator('.xterm-rows')).toContainText('survives-window-close', {
    timeout: 20_000,
  })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
      timeout: 20_000,
    })
    .toBe(0)

  const reopening = app.waitForEvent('window')
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('activate')
  })
  const reopened = await reopening
  await expect(reopened.locator('.xterm-rows')).toContainText('survives-window-close', {
    timeout: 20_000,
  })

  // One session, not two: a replacement rather than a reattach would leave the
  // original running and invisible.
  const { stdout } = await run('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])
  const sessions = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  expect(sessions.filter((name) => name.startsWith('prcli-'))).toHaveLength(1)

  await app.close()
})
