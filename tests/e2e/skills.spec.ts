/**
 * The skills panel and the ⌘K palette, against a fixture `~/.claude` rather
 * than whatever is installed on the machine that day.
 *
 * `PRCLI_CLAUDE_HOME` is a required launch option, so this spec points the app
 * at a temp tree holding four known entries and asserts against a known list.
 * That is what makes "the panel shows the right names" a real assertion here
 * rather than a restatement of the developer's own plugin set.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'prcli-e2e-skills'

/**
 * What the pane's shell prints if `/browse` is ever actually submitted.
 *
 * `/browse` is a path, not a command name, so a shell reports it as missing
 * rather than as "command not found". zsh says
 * `zsh: no such file or directory: /browse` and bash says
 * `bash: /browse: No such file or directory`, which is why this matches
 * case-insensitively on the shared phrase rather than on either wording.
 *
 * Derived by running Mutation B and reading the pane, not guessed: if the
 * shell on this machine prints something else, that output is what belongs
 * here, and the mutation is what tells you.
 */
const SUBMITTED = /no such file or directory/i

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string

const write = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-skills-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-skills-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-skills-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-skills-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-skills-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })

  // No enabled plugins: this spec is about the surfaces, and a plugin fixture
  // would add a registry file without adding an assertion.
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  // Two user skills, one user command, one repo command. `zebra` exists so the
  // filter has something to exclude, and the repo entry so the `repo` tag has
  // a subject.
  await write(join(claudeHome, 'skills', 'browse', 'SKILL.md'), '---\ndescription: Fast browser.\n---\n')
  await write(join(claudeHome, 'skills', 'zebra', 'SKILL.md'), '---\ndescription: Last one.\n---\n')
  await write(join(claudeHome, 'commands', 'gsd', 'stats.md'), '---\ndescription: Show stats.\n---\n')
  await write(join(projectCwd, '.claude', 'commands', 'shipit.md'), '---\ndescription: Ship it.\n---\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      // `slug` is required: `isProject` (src/main/state/store.ts:94) drops a
      // project row without one, silently, and the panel then never fetches.
      projects: [{ id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [] }],
      tabs: [],
      activeProjectId: 'p1',
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

test('the panel lists the project\'s skills and commands in name order', async () => {
  const rows = page.locator('[data-testid^="skill-"]')
  await expect(rows).toHaveCount(4)
  // Non-empty asserted by the count above, before anything reads the contents.
  // The name span, not the row: a row also renders the `repo` tag, so reading
  // the whole row would compare against 'shipit repo'.
  const names = page.locator('[data-testid^="skill-"] > span:first-child')
  expect(await names.allInnerTexts()).toEqual(['browse', 'gsd:stats', 'shipit', 'zebra'])
})

test('a project\'s own command is tagged repo and the others are not', async () => {
  await expect(page.getByTestId('skill-shipit')).toContainText('repo')
  await expect(page.getByTestId('skill-browse')).not.toContainText('repo')
})

test('the filter narrows to matches and says so when nothing matches', async () => {
  const filter = page.getByTestId('skills-filter')
  await filter.fill('brow')
  const rows = page.locator('[data-testid^="skill-"]')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('skill-browse')).toBeVisible()

  await filter.fill('qqqq')
  await expect(page.getByTestId('skills-empty')).toContainText('Nothing matches')
  await expect(rows).toHaveCount(0)

  await filter.fill('')
  await expect(rows).toHaveCount(4)
})

test('clicking a skill types its invocation and does NOT submit it', async () => {
  // A negative claim. `expect.poll` and `toHaveCount` return on their first
  // match and cannot express "and then nothing else happened", so this settles
  // first and reads the pane afterwards.
  //
  // A plain shell, NOT `preset-default-claude`. A `claude` pane in a directory
  // claude has never seen opens its first-run trust prompt, which consumes the
  // keystrokes and answers nothing either way, so the assertion below could
  // not fail. `launch.spec.ts` shows a `new-tab` shell echoing real input.
  await page.getByTestId('new-tab').click()
  const pane = page.getByTestId('terminal').first()
  await expect(pane).toBeVisible()

  await page.getByTestId('skills-filter').fill('brow')
  await page.getByTestId('skill-browse').click()

  // Let anything that was going to happen happen.
  await page.waitForTimeout(750)

  const text = await page.locator('.xterm-rows').first().innerText()
  expect(text).toContain('/browse')
  // If it had submitted, the shell would have answered. This is the assertion
  // the settle above exists for, and `SUBMITTED` is derived from what the
  // shell actually prints under Mutation B rather than guessed at.
  expect(text).not.toMatch(SUBMITTED)
})

test('⌘K opens the palette while a terminal has focus, and Escape closes it', async () => {
  // "It should be free, ⌘T and ⌘W already work through the same listener" is
  // an argument, and three dead tests in Plan 1 came from arguments. This is
  // the test instead.
  await page.getByTestId('terminal').first().click()
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toBeHidden()
})

test('an empty query lists sessions and no actions', async () => {
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  const sessions = page.locator('[data-testid^="palette-session-"]')
  await expect(sessions).not.toHaveCount(0)
  // Settle, then assert the absence: a count of zero is the claim, and
  // toHaveCount would return on its first match if any appeared later.
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid^="palette-action-"]').count()).toBe(0)

  await page.keyboard.press('Escape')
})

test('typing brings skills in below the sessions', async () => {
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('brow')
  const action = page.getByTestId('palette-action-browse')
  await expect(action).toBeVisible()
  await expect(action).toContainText('/browse')

  // Not just that both lists exist: every session row above every action
  // row. Swapping the two `.map` blocks in CommandPalette.tsx would leave the
  // assertions above green, since neither one names a position.
  //
  // `d`, not `brow`: every session label here is `demo · <id>`, because
  // `labelOfPane` falls back to that whenever a tab has no name and no test in
  // this file names one. A tmux session id is lowercase hex, which never
  // contains `w`, so `brow`
  // above matches no session at all and this order check needs both lists
  // populated at once. `d` matches every session through the literal `demo`
  // and matches `gsd:stats`, the one fixture entry with a `d` in it, without
  // depending on the id's random hex.
  await page.getByTestId('palette-input').fill('d')
  const rows = page.locator('[data-testid^="palette-session-"], [data-testid^="palette-action-"]')
  await expect(rows).not.toHaveCount(0)
  const ids = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))
  const sessionIds = ids.filter((id) => id.startsWith('palette-session-'))
  const actionIds = ids.filter((id) => id.startsWith('palette-action-'))
  expect(sessionIds.length).toBeGreaterThan(0)
  expect(actionIds.length).toBeGreaterThan(0)
  expect(ids.findIndex((id) => id.startsWith('palette-action-'))).toBeGreaterThan(
    ids.findLastIndex((id) => id.startsWith('palette-session-')),
  )

  await page.keyboard.press('Escape')
})

test('choosing a skill from the palette types it and closes the palette', async () => {
  await page.keyboard.press('Meta+k')
  // Cleared on open, not carried over from whatever an earlier test left in
  // it: CommandPalette's own effect does this, and it was otherwise untested.
  await expect(page.getByTestId('palette-input')).toHaveValue('')
  // `zebra`, not `browse`: the panel test above already typed `/browse` into
  // this same pane, so asserting `/browse` here would pass even with this
  // path's `onInsert` stubbed to a no-op. `zebra` is untouched by every test
  // above it, which is what makes this assertion belong to the palette.
  await page.getByTestId('palette-input').fill('zeb')
  await page.getByTestId('palette-action-zebra').click()
  await expect(page.getByTestId('command-palette')).toBeHidden()

  await page.waitForTimeout(750)
  const text = await page.locator('.xterm-rows').first().innerText()
  expect(text).toContain('/zebra')
})

test('⌘W typed into the palette does not destroy a pane', async () => {
  const before = await page.locator('[data-testid^="tab-"]').count()
  expect(before).toBeGreaterThan(0)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').click()
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  expect(await page.locator('[data-testid^="tab-"]').count()).toBe(before)
})

test('choosing a session from the palette switches the active tab', async () => {
  const original = page.locator('[data-testid^="tab-"]')
  await expect(original).toHaveCount(1)
  const originalId = (await original.first().getAttribute('data-testid'))?.slice('tab-'.length)
  if (!originalId) throw new Error('no tab id found')

  // A second tab so switching is a real choice, not a no-op back to the tab
  // already active. `new-tab` activates what it opens, so `originalId` starts
  // this test not-active.
  await page.getByTestId('new-tab').click()
  const tabs = page.locator('[data-testid^="tab-"]')
  await expect(tabs).toHaveCount(2)
  await expect(page.getByTestId(`tab-${originalId}`)).toHaveAttribute('data-active', 'false')

  await page.keyboard.press('Meta+k')
  // The raw pane id, not the label: same reason CommandPalette's own testids
  // are keyed on it rather than the truncated text a row renders.
  await page.getByTestId(`palette-session-${originalId}`).click()
  await expect(page.getByTestId('command-palette')).toBeHidden()
  await expect(page.getByTestId(`tab-${originalId}`)).toHaveAttribute('data-active', 'true')
})

test('⌘W typed into the skills filter does not destroy a pane', async () => {
  // Same guard as the palette's input, same reason: without it ⌘W typed while
  // filtering closes the active pane and destroys its tmux session.
  const before = await page.locator('[data-testid^="tab-"]').count()
  expect(before).toBeGreaterThan(0)
  await page.getByTestId('skills-filter').fill('z')
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid^="tab-"]').count()).toBe(before)
})
