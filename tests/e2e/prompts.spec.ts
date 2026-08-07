/**
 * The PROMPTS column: saved prompts that are global to the app, typed into the
 * active pane and never submitted.
 *
 * A fresh spec file with its own page, like `notes.spec.ts`, so no earlier
 * file's typing makes an assertion here vacuous. Within the file the tests
 * share one page and run in order: the list one test saves is the list the
 * next one deletes from.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { chmod, mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn, terminalTexts } from './harness'

const SOCKET = 'pterm-e2e-prompts'

/** Long enough to be recognisable in a terminal, and the user's real example. */
const HANDOVER = 'give me a handover prompt for a fresh context window'

/**
 * What the pane's shell prints if the prompt is ever actually submitted.
 *
 * Borrowed from `skills.spec.ts`: a missing command is reported differently by
 * zsh and bash, so this matches the phrase they share rather than either
 * wording. `give` is not a command on any of them.
 */
const SUBMITTED = /command not found|not found/i

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-prompts-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-prompts-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-prompts-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-prompts-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-prompts-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  const betaCwd = join(projectsRoot, 'beta')
  await mkdir(alphaCwd, { recursive: true })
  await mkdir(betaCwd, { recursive: true })

  // Two projects, because "global" is the claim this file has to make: a
  // prompt saved under one has to be on screen under the other.
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [
        { id: 'id-alpha', name: 'alpha', slug: 'alpha', cwd: alphaCwd, presets: [] },
        { id: 'id-beta', name: 'beta', slug: 'beta', cwd: betaCwd, presets: [] },
      ],
      tabs: [],
      activeProjectId: 'id-alpha',
      activeTabId: null,
    }),
  )

  app = await launch()
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the column starts collapsed and opens to an empty list', async () => {
  await expect(page.getByTestId('prompts-panel')).toHaveCount(0)
  await expect(page.getByTestId('prompts-toggle')).toBeVisible()
  await expandColumn(page, 'prompts')
  await expect(page.getByTestId('prompts-empty')).toContainText('No prompts yet')
  await expect(page.locator('[data-testid^="prompt-"]')).toHaveCount(0)
})

test('the + dialog refuses an incomplete prompt and saves a complete one', async () => {
  await page.getByTestId('prompts-new').click()
  await expect(page.getByTestId('prompts-dialog')).toBeVisible()

  // Disabled with nothing typed, and still disabled with only a name: a save
  // that wrote an empty body would put a row on screen that types nothing.
  await expect(page.getByTestId('prompts-save')).toBeDisabled()
  await page.getByTestId('prompts-label').fill('Handover')
  await expect(page.getByTestId('prompts-save')).toBeDisabled()

  await page.getByTestId('prompts-body').fill(HANDOVER)
  await page.getByTestId('prompts-save').click()

  // The dialog closes and the row arrives under its name, not its body.
  await expect(page.getByTestId('prompts-dialog')).toHaveCount(0)
  const rows = page.locator('[data-testid^="prompt-"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveText('Handover')

  // And it is on disk, in a file of its own beside config.json rather than
  // inside it. Polled: the write lands asynchronously.
  await expect
    .poll(async () => {
      const raw = await readFile(join(configDir, 'prompts.json'), 'utf8').catch(() => null)
      return raw === null ? null : (JSON.parse(raw) as { prompts: { body: string }[] }).prompts[0].body
    })
    .toBe(HANDOVER)
})

/**
 * The failure that shipped silent.
 *
 * The panel first swallowed a rejected `promptsAdd`: the dialog closed, no row
 * appeared, and nothing said why. That is exactly what a user sees when the
 * main process has no handler registered for the channel, which is the normal
 * state of a dev app whose renderer has hot-reloaded and whose main has not,
 * and it was reported as "I added a prompt and it didn't add".
 *
 * A revoked config directory rather than a stubbed bridge, because
 * `window.pterm` is frozen by `contextBridge` and cannot be replaced from an
 * `evaluate` (the assignment silently no-ops). Taking write permission away
 * from the directory makes the real write fail in main, which is the same
 * shape of failure arriving through the same path.
 */
test('a save that fails says so, and keeps the dialog and its text', async () => {
  await chmod(configDir, 0o500)
  try {
    await page.getByTestId('prompts-new').click()
    await page.getByTestId('prompts-label').fill('Doomed')
    await page.getByTestId('prompts-body').fill('this write cannot land')
    await page.getByTestId('prompts-save').click()

    // Said, not swallowed.
    await expect(page.getByTestId('prompts-error')).toContainText('Not saved')
    // Still open, still holding what was typed: the user can fix the cause and
    // press Save again rather than retyping a prompt they have lost.
    await expect(page.getByTestId('prompts-dialog')).toBeVisible()
    await expect(page.getByTestId('prompts-body')).toHaveValue('this write cannot land')
    // And no phantom row: the list is what main answered with, which is nothing.
    await expect(page.locator('[data-testid^="prompt-"]')).toHaveCount(1)
  } finally {
    await chmod(configDir, 0o700)
  }

  // The retry lands once the cause is gone, which is the point of keeping the
  // text. Then it is removed again so the tests after this see the one prompt
  // they were written against.
  await page.getByTestId('prompts-save').click()
  await expect(page.getByTestId('prompts-dialog')).toHaveCount(0)
  const rows = page.locator('[data-testid^="prompt-"]')
  await expect(rows).toHaveCount(2)
  const doomed = (await rows.nth(1).getAttribute('data-testid'))!.replace('prompt-', '')
  await page.getByTestId(`pdelete-${doomed}`).click()
  await expect(rows).toHaveCount(1)
})

test('clicking a prompt types it into the active pane and does NOT submit it', async () => {
  // A plain shell rather than a claude pane, for `skills.spec.ts`'s reason: a
  // claude pane in a directory claude has never seen opens a trust prompt that
  // eats the keystrokes, and the negative assertion below could not fail.
  await page.getByTestId('new-tab').click()
  const pane = page.getByTestId('terminal').first()
  await expect(pane).toBeVisible()

  await page.locator('[data-testid^="prompt-"]').first().click()

  // Settle before reading: "and then nothing else happened" cannot be polled
  // for, so this waits and then reads the pane once.
  await page.waitForTimeout(750)
  const text = (await terminalTexts(page))[0] ?? ''
  expect(text).toContain('handover prompt')
  expect(text).not.toMatch(SUBMITTED)
})

test('a prompt saved under one project is there under the other', async () => {
  // The whole point of the store being global. `promptsList` takes no project
  // id, so the risk is not that the panel filters wrongly but that someone
  // later makes it per project; this is what would fail.
  await page.getByTestId('project-id-beta').click()
  await expect(page.locator('[data-testid^="prompt-"]')).toHaveCount(1)
  await page.getByTestId('project-id-alpha').click()
})

test('a prompt survives a relaunch, and delete removes it for good', async () => {
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await expandColumn(page, 'prompts')

  const rows = page.locator('[data-testid^="prompt-"]')
  await expect(rows).toHaveCount(1)
  const id = (await rows.first().getAttribute('data-testid'))!.replace('prompt-', '')

  // `pdelete-`, not `prompt-delete-`: the row locator above counts everything
  // under the `prompt-` prefix, and a delete button named that way would make
  // this count 2 while the panel showed one prompt.
  await page.getByTestId(`pdelete-${id}`).click()
  await expect(rows).toHaveCount(0)
  await expect(page.getByTestId('prompts-empty')).toBeVisible()

  // Gone from the file too, not merely from the screen.
  await expect
    .poll(async () => {
      const raw = await readFile(join(configDir, 'prompts.json'), 'utf8').catch(() => null)
      return raw === null ? null : (JSON.parse(raw) as { prompts: unknown[] }).prompts.length
    })
    .toBe(0)
})
