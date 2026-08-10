/**
 * The strip that says no dot will ever move, and the startup migration that
 * makes it unnecessary for anyone upgrading across the PRCLI→pTerm rename.
 *
 * Written after three days in which the app dropped every hook event and said
 * nothing: `~/.claude/settings.json` still named `~/.prcli/bin/prcli-hook`,
 * which gates on `$PRCLI_TAB_ID` and so exited before sending anything. The
 * only symptom was dots that never appeared, which is also what a quiet
 * morning looks like.
 *
 * What this file does NOT cover:
 *
 * - **the script Claude actually runs.** Nothing here executes a hook or runs
 *   a real Claude process; the migration is asserted on the file's contents,
 *   the same bargain `status.spec.ts` names for its own install test;
 * - **the real `~/.claude/settings.json`.** `PTERM_CLAUDE_SETTINGS` points at
 *   a temp file in every test here. The legacy fixture does name a path under
 *   the developer's real home — `legacyHookPaths()` resolves against
 *   `os.homedir()`, so the string has to match — but that path is only ever
 *   written into the temp file and compared against; no file under `~/.prcli`
 *   is created, read, or removed;
 * - **dismissal surviving a relaunch.** It deliberately does not. See
 *   `HooksBar`'s own comment for why it is per-run;
 * - **a settings file that will not parse.** `readHooksState` throws there and
 *   the strip stays down by construction (`App.tsx` catches into `false`);
 *   that the settings pane surfaces the error instead is `install.test.ts`'s.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { hookCommand } from '../../src/main/hooks/install'
import { HOOK_EVENTS } from '../../src/main/status/machine'
import { DEFAULT_NOTIFICATIONS } from '../../src/main/state/store'

const SOCKET = 'pterm-e2e-hooksbar'

/** The pre-rename script path, exactly as `legacyHookPaths()` resolves it. */
const LEGACY = join(homedir(), '.prcli', 'bin', 'prcli-hook')

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

interface HookFile {
  hooks?: Record<string, { hooks?: { command?: string }[] }[]>
}

/** Every command string in a parsed settings file, flattened. */
function commandsIn(file: HookFile): string[] {
  return Object.values(file.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => (group.hooks ?? []).map((entry) => entry.command ?? '')),
  )
}

async function seed(): Promise<void> {
  const cwd = join(projectsRoot, 'alpha')
  await mkdir(join(cwd, '.git'), { recursive: true })
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 4,
      projects: [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd, presets: [], activeTabId: null }],
      activeProjectId: 'id-alpha',
      tabs: [],
      notifications: DEFAULT_NOTIFICATIONS,
    }),
    'utf8',
  )
}

/**
 * That the strip is painted where it claims to be, not merely present.
 *
 * `toBeVisible` has passed in this suite on an element painted behind the
 * terminal, so the assertion is geometric: a real box, inside the viewport,
 * in the top band of the window, and above whatever the app draws below it.
 */
async function assertPaintedAtTop(window: Page): Promise<void> {
  const bar = window.getByTestId('hooks-bar')
  await expect(bar).toBeVisible()
  const box = await bar.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(100)
  expect(box!.height).toBeGreaterThan(10)
  // `globalThis`, not `window`: inside the callback `window` resolves to the
  // Playwright `Page` this function was handed, not to the page's own window.
  const viewport = await window.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }))
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeLessThan(viewport.height / 4)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-hb-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-hb-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-hb-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-hb-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-hb-claude-'))
  await seed()
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file with no pTerm hook says so, and Install ends it', async () => {
  await writeFile(claudeSettingsPath, JSON.stringify({ model: 'opusplan' }, null, 2), 'utf8')

  const app = await launch()
  const window = await app.firstWindow()

  await assertPaintedAtTop(window)
  await expect(window.getByTestId('hooks-bar-message')).toContainText('not installed')

  await window.getByTestId('hooks-bar-install').click()
  await expect(window.getByTestId('hooks-bar')).toHaveCount(0)

  const written = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as HookFile
  for (const event of HOOK_EVENTS) {
    expect((written.hooks ?? {})[event]).toBeDefined()
  }
  expect(commandsIn(written).some((command) => command.includes('pterm-hook'))).toBe(true)

  await app.close()
})

test('dismissing it leaves the settings file alone', async () => {
  const original = `${JSON.stringify({ model: 'opusplan' }, null, 2)}\n`
  await writeFile(claudeSettingsPath, original, 'utf8')

  const app = await launch()
  const window = await app.firstWindow()

  await expect(window.getByTestId('hooks-bar')).toBeVisible()
  await window.getByTestId('hooks-bar-dismiss').click()
  await expect(window.getByTestId('hooks-bar')).toHaveCount(0)

  expect(await readFile(claudeSettingsPath, 'utf8')).toBe(original)

  await app.close()
})

test('an already-installed file draws no strip at all', async () => {
  // Built the way the app builds it, so this cannot pass against a shape the
  // installer would not actually produce.
  const hooks: Record<string, unknown[]> = {}
  const script = join(configDir, 'bin', 'pterm-hook')
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(script, event) }] }]
  }
  await writeFile(claudeSettingsPath, JSON.stringify({ hooks }, null, 2), 'utf8')

  const app = await launch()
  const window = await app.firstWindow()

  // The strip is rendered from an async read, so an assertion that fires
  // before the reply lands would pass against a bar that appears a tick
  // later. Wait for something the same render pass paints first.
  await expect(window.getByTestId('new-tab')).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId('hooks-bar')).toHaveCount(0)

  await app.close()
})

test('a pre-rename install is re-pointed at startup, with no strip and a backup', async () => {
  const fixture = {
    model: 'opusplan',
    hooks: {
      // A hook of the user's own, sharing the event with ours. It has to come
      // back, which is why the migration strips entries and not whole groups.
      Stop: [
        { hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] },
        { hooks: [{ type: 'command', command: hookCommand(LEGACY, 'Stop') }] },
      ],
      SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand(LEGACY, 'SessionEnd') }] }],
    },
  }
  await writeFile(claudeSettingsPath, JSON.stringify(fixture, null, 2), 'utf8')

  const app = await launch()
  const window = await app.firstWindow()

  await expect(window.getByTestId('new-tab')).toBeVisible({ timeout: 20_000 })
  // The whole point of the migration: the user who was silently broken sees
  // nothing at all, because there is nothing left to warn about.
  await expect(window.getByTestId('hooks-bar')).toHaveCount(0)

  const written = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as HookFile
  const commands = commandsIn(written)
  expect(commands.some((command) => command.includes('.prcli'))).toBe(false)
  expect(commands).toContain('afplay /System/Library/Sounds/Glass.aiff')
  for (const event of HOOK_EVENTS) {
    expect((written.hooks ?? {})[event]).toBeDefined()
  }

  // The file was rewritten unattended, so the copy the user had must still
  // exist. Asserted on contents, not just on a name ending in .bak.
  const backups = (await readdir(claudeSettingsDir)).filter((name) => name.endsWith('.bak'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(claudeSettingsDir, backups[0]), 'utf8')).toContain('.prcli')

  await app.close()
})
