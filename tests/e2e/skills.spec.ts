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
