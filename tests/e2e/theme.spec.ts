/**
 * What the theme picker actually claims, measured off the rendered document.
 *
 * Every other test in this feature asserts a value in a table. These assert
 * the consequence the feature exists for: that after choosing a stepped
 * theme, the dialog the user is looking at is a different plane from the panel
 * behind it, and that the choice survives a relaunch having been applied
 * before anything was painted.
 *
 * A class-name assertion would stay green with the two fills identical, which
 * is precisely the state this feature was built to leave behind: the palette
 * that ships defines `--color-bg` and `--color-surface` three points apart, a
 * CIE L* distance of 0.86, below the difference at which two adjacent fills
 * are distinguishable at all.
 */
import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { parseRgb, lightnessGap } from './colour'
import { CHANNELS, type MenuCommand } from '../../src/shared/ipc'
import { THEMES } from '../../src/shared/themes'

const SOCKET = 'pterm-e2e-theme'

const SETTINGS_COMMAND: MenuCommand = 'settings'

/** The floor two fills must clear to read as separate planes. See `src/shared/themes.ts`. */
const FILL_FLOOR = 3.0

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

async function launch(): Promise<void> {
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-theme-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-theme-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-theme-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-theme-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-theme-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  await mkdir(alphaCwd, { recursive: true })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'id-alpha', name: 'alpha', slug: 'alpha', cwd: alphaCwd, presets: [] }],
      tabs: [],
      activeProjectId: 'id-alpha',
      activeTabId: null,
    }),
  )

  await launch()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const openSettings = async (): Promise<void> => {
  expect(CHANNELS.menuCommand).toBe('pterm:menuCommand')
  expect(SETTINGS_COMMAND).toBe('settings')
  // The command is fire and forget: sent before the renderer has mounted, it
  // reaches nothing and the pane never opens. Waiting on a piece of chrome
  // that is always present is what makes the send land on a live listener.
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })
  await expect(page.getByTestId('settings-pane')).toBeVisible()
}

/**
 * An element's painted background as hex.
 *
 * The emptiness check is not decoration. A locator that matches nothing, or an
 * element with no background of its own, yields `rgba(0, 0, 0, 0)`, which
 * converts to `#000000` and would clear any floor it were compared against.
 * That is the exact shape of the vacuous assertion this repo has shipped
 * before, so the transparent case fails loudly instead of passing quietly.
 */
async function fillOf(locator: Locator): Promise<string> {
  const value = await locator.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(value, 'element has no painted background of its own').not.toMatch(/,\s*0\s*\)$/)
  return parseRgb(value)
}

/** The value a custom property resolves to on the document, as hex. */
async function tokenOf(name: string): Promise<string> {
  const value = await page.evaluate(
    (prop) => getComputedStyle(document.documentElement).getPropertyValue(prop).trim(),
    name,
  )
  expect(value, `${name} resolves to nothing`).not.toBe('')
  return value.toLowerCase()
}

const chooseTheme = async (id: string): Promise<void> => {
  await page.getByTestId(`theme-${id}`).click()
  await expect(page.getByTestId(`theme-${id}`)).toHaveAttribute('aria-checked', 'true')
}

test('opens on the picker and offers every theme in the registry', async () => {
  await openSettings()
  await expect(page.getByTestId('theme-picker')).toBeVisible()
  for (const id of Object.keys(THEMES)) {
    await expect(page.getByTestId(`theme-${id}`)).toBeVisible()
  }
})

test('the shipped palette draws a dialog in the same fill as the panel behind it', async () => {
  await chooseTheme('classic')

  const panel = await fillOf(page.getByTestId('sidebar'))
  const dialog = await fillOf(page.getByTestId('settings-pane'))

  // Recorded rather than asserted good. This is the defect the other four
  // themes answer, and pinning it here means a later change that quietly
  // fixes Classic has to come and edit this line, which is where the
  // reasoning for leaving it alone lives.
  expect(lightnessGap(dialog, panel)).toBeLessThan(1)
})

test('a stepped theme lifts the dialog onto its own plane', async () => {
  await chooseTheme('stepped')

  const panel = await fillOf(page.getByTestId('sidebar'))
  const dialog = await fillOf(page.getByTestId('settings-pane'))

  expect(panel).toBe(THEMES.stepped.tokens.surface)
  expect(dialog).toBe(THEMES.stepped.tokens.overlay)
  expect(lightnessGap(dialog, panel)).toBeGreaterThanOrEqual(FILL_FLOOR)
})

test('lifting the chrome separates the side columns from the terminal ground', async () => {
  await chooseTheme('lifted')

  const panel = await fillOf(page.getByTestId('sidebar'))
  const canvas = await tokenOf('--color-bg')

  expect(panel).toBe(THEMES.lifted.tokens.surface)
  expect(canvas).toBe(THEMES.lifted.tokens.bg)
  expect(lightnessGap(panel, canvas)).toBeGreaterThanOrEqual(FILL_FLOOR)
})

test('workspace light gives the sidebar a pale chrome plane over a white canvas', async () => {
  await chooseTheme('workspaceLight')

  const panel = await fillOf(page.getByTestId('sidebar'))
  const canvas = await tokenOf('--color-bg')

  expect(panel).toBe(THEMES.workspaceLight.tokens.surface)
  expect(canvas).toBe(THEMES.workspaceLight.tokens.bg)
  expect(lightnessGap(panel, canvas)).toBeGreaterThanOrEqual(FILL_FLOOR)
  await expect(page.getByTestId('workspace-context')).toHaveCount(0)
})

test('the choice reaches the config file', async () => {
  await chooseTheme('slate')

  // Polled: the click paints immediately and stores over IPC, so the file is
  // written a moment behind the pixels by design.
  await expect
    .poll(async () => {
      const raw = await readFile(join(configDir, 'config.json'), 'utf8')
      return (JSON.parse(raw) as { theme?: string }).theme
    })
    .toBe('slate')
})

test('a relaunch comes up already painted in the stored theme', async () => {
  await app.close()
  await launch()

  // Waiting on the title bar rather than asserting straight away: `firstWindow`
  // resolves once the window exists, which is before its bundle has run, and
  // reading the attribute then finds a document nothing has touched yet.
  //
  // It does not weaken the claim. `main.tsx` calls `applyTheme` above
  // `createRoot`, so any React output at all, the title bar included, is proof
  // the palette was applied before it.
  await expect(page.getByTestId('titlebar')).toBeVisible()

  // No settings pane opened, nothing clicked: this is what the window painted
  // itself on startup, from the value the main process put on the command
  // line before the window existed.
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('slate')
  expect(await tokenOf('--color-surface')).toBe(THEMES.slate.tokens.surface)
  expect(await fillOf(page.getByTestId('sidebar'))).toBe(THEMES.slate.tokens.surface)
})
