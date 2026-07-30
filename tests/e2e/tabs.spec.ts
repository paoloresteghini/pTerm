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

/** Total tmux clients attached across every session on the test socket. */
async function attachedClients(): Promise<number> {
  try {
    const { stdout } = await run('tmux', [
      '-L', SOCKET, 'list-sessions', '-F', '#{session_attached}',
    ])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((total, count) => total + Number(count), 0)
  } catch {
    return 0
  }
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  await killServer()
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
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
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

test('opens several tabs and keeps each one\'s scrollback', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()

  await window.getByTestId('terminal-active').click()
  await window.keyboard.type('echo first-tab')
  await window.keyboard.press('Enter')
  await expect(window.locator('.xterm-rows')).toContainText('first-tab', { timeout: 20_000 })

  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)

  await window.getByTestId('terminal-active').click()
  await window.keyboard.type('echo second-tab')
  await window.keyboard.press('Enter')
  await expect(window.getByTestId('terminal-active')).toContainText('second-tab', {
    timeout: 20_000,
  })
  // The first tab's content is hidden, not gone.
  await expect(window.getByTestId('terminal-active')).not.toContainText('first-tab')

  const tabs = window.locator('[data-testid^="tab-"]')
  await expect(tabs).toHaveCount(2)
  await tabs.first().click()
  await expect(window.getByTestId('terminal-active')).toContainText('first-tab', {
    timeout: 20_000,
  })

  await app.close()
})

test('restores every tab and the active one after a relaunch', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)

  await firstWindow.getByTestId('terminal-active').click()
  await firstWindow.keyboard.type('echo marker-two')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.getByTestId('terminal-active')).toContainText('marker-two', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  // The second tab was active when we quit, and its scrollback came back.
  await expect(secondWindow.getByTestId('terminal-active')).toContainText('marker-two', {
    timeout: 20_000,
  })
  await second.close()
})

test('adopts a session the app has never seen', async () => {
  // Exactly what a crash or an external tmux command leaves behind.
  await run('tmux', [
    '-L', SOCKET, 'new-session', '-d', '-s', 'prcli-scratch-abcdef0123456789', 'sleep', '600',
  ])

  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect(window.getByTestId('tab-abcdef0123456789')).toBeVisible()

  await app.close()
})

test('reloading the window reattaches what is open instead of stranding it', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
  const before = (await sessionNames()).sort()

  // Exactly what View → Reload, or a renderer crash, does.
  await app.evaluate(({ BrowserWindow }) => {
    const [target] = BrowserWindow.getAllWindows()
    target.webContents.reload()
  })

  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)
  // Long enough for a restore that found nothing to have opened a stray.
  await window.waitForTimeout(1500)
  expect((await sessionNames()).sort()).toEqual(before)

  await app.close()
})

test('a detach from inside the pane leaves the tab and its session alone', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)
  const before = await sessionNames()

  // Wait for a prompt: tmux must be up before it will act on its prefix key.
  await window.getByTestId('terminal-active').click()
  await expect(window.getByTestId('terminal-active')).toContainText(/[$%#]/, { timeout: 20_000 })

  // The tmux user's reflex. The client dies; the session does not.
  await window.keyboard.press('Control+b')
  await window.keyboard.press('d')
  await expect.poll(attachedClients, { timeout: 20_000 }).toBe(0)
  // Long enough that a renderer deleting the tab on any exit event would have.
  await window.waitForTimeout(1500)

  expect(await sessionNames()).toEqual(before)
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await app.close()
})

test('closing a tab destroys its session', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)

  const closeButtons = window.locator('[data-testid^="close-"]')
  await closeButtons.first().click()

  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)

  await app.close()
})
