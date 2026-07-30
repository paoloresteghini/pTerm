import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

/** What tmux itself thinks the session's window measures. */
async function windowSize(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

async function savedActiveTabId(): Promise<unknown> {
  const raw: unknown = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  return (raw as { activeTabId?: unknown }).activeTabId
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

test('a restored background tab keeps its size instead of being squashed', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
  await firstWindow.waitForTimeout(1500)

  const names = (await sessionNames()).sort()
  const before = [await windowSize(names[0]), await windowSize(names[1])]
  // The app window is far wider than tmux's 80×24 default, so a pane that
  // never measured itself is unmistakable.
  expect(before[0]).not.toBe('80x24')
  expect(before[0]).toBe(before[1])
  await first.close()

  // Only one of these two comes back visible. The hidden one is attached by
  // the same client, and tmux sizes the session to whatever that client says.
  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect
    .poll(async () => [await windowSize(names[0]), await windowSize(names[1])], {
      timeout: 20_000,
    })
    .toEqual(before)
  // And it stays that way rather than settling back down.
  await secondWindow.waitForTimeout(1500)
  expect([await windowSize(names[0]), await windowSize(names[1])]).toEqual(before)

  await second.close()
})

test('a relaunch lands on the tab that closing another one activated', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.locator('[data-testid^="tab-"]')).toHaveCount(3)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(3)

  const ids = await firstWindow
    .locator('[data-testid^="tab-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))

  // Work on the middle tab, then close it. The third becomes active — and
  // that, not the first, is where the next launch has to land.
  await firstWindow.getByTestId(ids[1]).click()
  await expect(firstWindow.locator('[data-active="true"]')).toHaveAttribute('data-testid', ids[1])
  await firstWindow.getByTestId(ids[1].replace('tab-', 'close-')).click()
  await expect(firstWindow.locator('[data-active="true"]')).toHaveAttribute('data-testid', ids[2])
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
  // Let the config write land before the app goes away.
  await firstWindow.waitForTimeout(1000)
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect(secondWindow.locator('[data-active="true"]')).toHaveAttribute('data-testid', ids[2])
  // A launch that restores tabs must not report an active tab before it knows
  // of one: writing `null` at mount would wipe the value restore is reading.
  await secondWindow.waitForTimeout(1000)
  expect(await savedActiveTabId()).toBe(ids[2].replace('tab-', ''))
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

// ⌘T, ⌘W and ⌘1–9 are the milestone's headline feature and had no test at any
// level. This drives the renderer's handler, which is where the logic lives;
// it does not exercise the OS accelerator layer.
test('the keyboard opens, switches and closes tabs', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)
  const firstTab =
    (await window.locator('[data-testid^="tab-"]').first().getAttribute('data-testid')) ?? ''
  expect(firstTab).not.toBe('')

  await window.keyboard.press('Meta+t')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
  // The new tab takes over, so ⌘1 has somewhere to switch back from.
  await expect(window.locator('[data-active="true"]')).not.toHaveAttribute(
    'data-testid',
    firstTab,
  )

  await window.keyboard.press('Meta+1')
  await expect(window.locator('[data-active="true"]')).toHaveAttribute('data-testid', firstTab)

  // ⌘W closes the active tab, which is now the first one, and destroys
  // exactly that session.
  const firstSession = `prcli-scratch-${firstTab.replace('tab-', '')}`
  expect(await sessionNames()).toContain(firstSession)
  await window.keyboard.press('Meta+w')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)
  expect(await sessionNames()).not.toContain(firstSession)

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
