/**
 * The skills panel and the ⌘K palette, against a fixture `~/.claude` rather
 * than whatever is installed on the machine that day.
 *
 * `PTERM_CLAUDE_HOME` is a required launch option, so this spec points the app
 * at a temp tree holding four known entries and asserts against a known list.
 * That is what makes "the panel shows the right names" a real assertion here
 * rather than a restatement of the developer's own plugin set.
 *
 * **Measured 2026-08-04, the scrollbar rule**: three mutations against
 * `the panel and the terminal both scroll on the styled bar`, each failing
 * only its own assertion. Dropping `.xterm-viewport` from the rule in
 * `index.css` leaves the panel at 8 and returns the terminal to 15; dropping
 * `scroll-thin` from the skills container in `SkillsPanel.tsx` does the
 * reverse; recolouring the thumb to `--color-danger` leaves both widths at 8
 * and fails on `rgb(248, 113, 113)`. The 15 in the first two is the platform
 * bar this rule replaces, so a revert is a visible number here and not a zero.
 *
 * **This file shares one `page` across every test, and that is load-bearing
 * against it.** The scrollbar test first failed because
 * `clicking a skill types its invocation` leaves `brow` in the filter box and
 * nothing after it clears one, so by then the panel held ONE row, fit its box,
 * and laid out no bar at all. Running the file alone hid the failure entirely.
 * Anything added here that depends on the panel's contents must set them
 * rather than inherit them.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn, terminalTexts } from './harness'

const SOCKET = 'pterm-e2e-skills'

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
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-skills-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-skills-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-skills-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-skills-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-skills-claude-'))
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
  // Collapsed on a fresh profile, and every launch here is one. The whole
  // file reads this column, so it is opened once for all of it rather than
  // per test.
  await expandColumn(page, 'skills')
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

  const text = (await terminalTexts(page))[0] ?? ''
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
  // `d`, not `brow`: every session label is `demo · <id>` (`tabLabel`), and a
  // tmux session id is lowercase hex, which never contains `w`, so `brow`
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
  const text = (await terminalTexts(page))[0] ?? ''
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

test('the panel and the terminal both scroll on the styled bar, at its width', async () => {
  // Measured as LAYOUT, not as computed style, because a custom scrollbar's
  // cost and its proof are the same number: `offsetWidth - clientWidth` is the
  // width the bar takes out of the box, and nothing else in the box model
  // produces that difference on a container with no border.
  //
  // The number that makes this bite is what it USED to be. This environment
  // has no overlay scrollbars — measured 2026-08-04, the platform bar here is
  // classic and 15px — so before this rule both containers below read 15, and
  // both now read 8. A revert does not make them read 0; it makes them read
  // 15, which is why 8 is asserted rather than "not zero".
  //
  // Last in the file because it resizes the window, and every test above
  // shares this one page.

  // Opened here rather than relied on from a test above. Several of those do
  // open tabs, so `.xterm-viewport` would usually exist by now — but only
  // usually, and running this test alone found that out: it timed out waiting
  // for a viewport no earlier test had created.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })

  // Cleared, not inherited. `clicking a skill types its invocation` leaves
  // `brow` in this box and nothing after it puts the list back, so in a
  // full-file run the panel holds ONE row, fits its box, and lays out no bar
  // at all — measured, and it is how this test first failed. Running the file
  // alone hid it, because then no earlier test had typed anything.
  await page.getByTestId('skills-filter').fill('')
  await expect(page.locator('[data-testid^="skill-"]')).toHaveCount(4)

  // 180px, measured 2026-08-05. It was 240 while Skills and Presets shared one
  // column and the skills list was `flex-[2]` of it; Skills has its own column
  // now and its list takes the whole height, so at 240 the four rows fit and
  // nothing overflowed. The rule is unchanged: this height has to leave the
  // list smaller than its content or there is no bar to measure.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(760, 180)
  })

  const gutter = async (selector: string): Promise<number> =>
    // Typed: a `Locator` resolves to `HTMLElement | SVGElement`, and only the
    // HTML half has `offsetWidth`. Every selector passed here is a div.
    page.locator(selector).first().evaluate((node: HTMLElement) => node.offsetWidth - node.clientWidth)

  // Polled: the resize reaches the renderer asynchronously, and until it lands
  // the panel still fits its content and this reads 0.
  await expect.poll(async () => gutter('[data-testid="scroll-skills"]'), { timeout: 10_000 }).toBe(8)

  // The terminal, which is the surface the rule covers most of and the one it
  // was nearly written to exclude. `.xterm-viewport` is `overflow-y: scroll`,
  // so it is laid out with a bar whether or not there is scrollback to reach,
  // and dropping `.xterm-viewport` from the rule leaves the assertion above
  // green and fails only this one.
  //
  // Polled rather than read once, and the reason is a MITIGATION rather than a
  // diagnosis. This test failed twice on 2026-08-04, once in a full-suite run
  // and once alone, and then passed four times (three alone, one full suite)
  // without the error text ever being captured. What is known is that the
  // resize above makes xterm refit, and a refit is the one thing between here
  // and a settled viewport; polling costs nothing and covers a transient
  // measurement during it. If this line fails again, that it is polled is not
  // evidence the cause lies elsewhere.
  await expect.poll(async () => gutter('.xterm-viewport'), { timeout: 10_000 }).toBe(8)

  // The colour, separately and honestly: this reads the pseudo-element's
  // computed style, which says what was declared rather than what was
  // rasterised. `--color-faint`, #3f3f46.
  const thumb = await page
    .locator('[data-testid="scroll-skills"]')
    .evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor)
  expect(thumb).toBe('rgb(63, 63, 70)')
})
