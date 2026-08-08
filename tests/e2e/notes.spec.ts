/**
 * The NOTES column: per-project text that survives a project switch, a
 * collapse toggle, and a ⌘W typed mid-note.
 *
 * A fresh spec file with its own page, so no earlier file's typing makes an
 * assertion here vacuous. Within the file the tests still share one page, so
 * anything that depends on the textarea's contents must set them.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-notes'
const ALPHA_NOTE = 'startup: npm run dev'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-notes-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-notes-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-notes-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-notes-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-notes-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  const betaCwd = join(projectsRoot, 'beta')
  await mkdir(alphaCwd, { recursive: true })
  await mkdir(betaCwd, { recursive: true })

  // Two projects, so a switch is a real one. `slug` is required: `isProject`
  // (src/main/state/store.ts:94) silently drops a row without one.
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

  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a note typed under one project survives a switch away and back', async () => {
  // A fresh profile starts collapsed: no panel, no textarea, only the strip's
  // toggle. Asserted here rather than in beforeAll so the default is a real
  // test, not setup noise.
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(page.getByTestId('notes-textarea')).toHaveCount(0)
  // Hidden means hidden: there is no strip left behind to wait for or click,
  // so the way in is the shortcut the View menu item carries.
  await expandColumn(page, 'notes')

  const textarea = page.getByTestId('notes-textarea')
  // Enabled is "loaded": the component disables the textarea until the fetch
  // for the active project resolves.
  await expect(textarea).toBeEnabled()
  await textarea.fill(ALPHA_NOTE)

  // The switch is the flush: asserting persistence through it tests the save
  // path without racing the 500ms debounce.
  await page.getByTestId('project-id-beta').click()
  await expect(textarea).toBeEnabled()
  await expect(textarea).toHaveValue('')

  // The flush wrote a real file under the app's config dir, keyed by the id
  // the text was typed under. Polled: the IPC write lands asynchronously.
  await expect
    .poll(() => readFile(join(configDir, 'notes', 'id-alpha.md'), 'utf8').catch(() => null))
    .toBe(ALPHA_NOTE)

  await page.getByTestId('project-id-alpha').click()
  await expect(textarea).toHaveValue(ALPHA_NOTE)
})

test('a note typed under beta does not leak into alpha', async () => {
  // The id-capture race, from the UI side: type under beta, switch to alpha
  // before the debounce fires, and alpha's file must be untouched.
  await page.getByTestId('project-id-beta').click()
  const textarea = page.getByTestId('notes-textarea')
  await expect(textarea).toBeEnabled()
  await expect(textarea).toHaveValue('')
  await textarea.fill('beta only')
  await page.getByTestId('project-id-alpha').click()
  await expect(textarea).toHaveValue(ALPHA_NOTE)
  await expect
    .poll(() => readFile(join(configDir, 'notes', 'id-beta.md'), 'utf8').catch(() => null))
    .toBe('beta only')
  expect(await readFile(join(configDir, 'notes', 'id-alpha.md'), 'utf8')).toBe(ALPHA_NOTE)
})

/*
 * The two gestures a column has, and the difference between them.
 *
 * The heading SETS ASIDE: the panel goes and the strip stays, one click from
 * open. The View menu's item and its shortcut REMOVE: the strip goes too. They
 * were briefly the same thing, and setting a column aside then took away the
 * only way back that is not the menu.
 */
test('the heading collapses to a strip, and the shortcut hides the column outright', async () => {
  await expect(page.getByTestId('notes-textarea')).toBeVisible()

  // Aside: panel gone, strip kept. The strip carries the same testid the
  // heading does, so its presence is what separates the two states.
  await page.getByTestId('notes-toggle').click()
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(page.getByTestId('notes-textarea')).toHaveCount(0)
  await expect(page.getByTestId('notes-toggle')).toBeVisible()

  // And back, by clicking that strip.
  await page.getByTestId('notes-toggle').click()
  await expect(page.getByTestId('notes-textarea')).toBeVisible()

  // Removed: nothing left at all, which is what the menu item is for.
  await page.keyboard.press('Alt+Meta+n')
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(page.getByTestId('notes-toggle')).toHaveCount(0)

  await expandColumn(page, 'notes')
  await expect(page.getByTestId('notes-textarea')).toBeVisible()
})

test('⌘W typed into the notes textarea does not destroy a pane', async () => {
  // Same guard as the skills filter, same reason, same shape of test.
  await page.getByTestId('new-tab').click()
  // Polled, not read once. The click starts a tmux session and the row it
  // adds arrives a frame or more later, so the bare `count()` this used to do
  // read 0 whenever it lost that race, the file's long-standing "known
  // flake", reproduced again on 2026-08-05 at `Expected: > 0, Received: 0`.
  // Every other spec that clicks `new-tab` waits for something first.
  const tabs = page.locator('[data-testid^="tab-"]')
  await expect.poll(() => tabs.count(), { timeout: 20_000 }).toBeGreaterThan(0)
  const before = await tabs.count()
  const textarea = page.getByTestId('notes-textarea')
  await textarea.click()
  await textarea.pressSequentially('mid-note ')
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid^="tab-"]').count()).toBe(before)
})
