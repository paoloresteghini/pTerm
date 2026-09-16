/**
 * The sidebar as a list you can arrange: what number each row carries, moving
 * a project, moving a tab inside a project, and closing a tab from its row.
 *
 * Four tests on the `pterm-e2e-sidebar` socket. The first is the one worth
 * reading twice: the badge on a row and the key that selects it are two
 * derivations of one order (`groupProjects`, `src/renderer/lib/projectOrder.ts`)
 * and nothing but a test can see them disagree. They did, for as long as the
 * sidebar grouped live projects above dormant ones while `⌘n` indexed
 * `state.projects`.
 *
 * **Why these do not use `new-tab`.** `TabBar` is behind `{false && ...}`
 * (`App.tsx`, `cf87ca2`), so the button 98 call sites across this suite click
 * does not render. Tabs are opened here through the File menu item instead,
 * which is the same command by the same id, and the sidebar's own `stab-` rows
 * are what the assertions read. That makes this file runnable at HEAD while
 * most of `projects.spec.ts` is not.
 *
 * **Drags are dispatched, not gestured.** Playwright's `dragTo` drives pointer
 * events and Electron does not synthesise those into HTML5 drag events, the
 * same reason `columnOrder.spec.ts` and `dragSplit.spec.ts` dispatch their
 * own. `clientY` is passed explicitly because the handlers read it: which half
 * of the target row the pointer is in is what decides whether the run lands
 * above or below, and a synthetic event without it reads as 0, which is every
 * drop landing "before".
 *
 * **What this file does not see.** It never drags a split (every tab here holds
 * one pane), never drags across projects, and never drags in the Inactive
 * group, which by design refuses: its order is derived from when each project
 * was last closed, so a drop there would be undone on the next render.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-sidebar'

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

async function candidate(name: string): Promise<string> {
  const cwd = join(projectsRoot, name)
  await mkdir(join(cwd, '.git'), { recursive: true })
  return cwd
}

async function seed(names: string[], activeProjectId: string): Promise<void> {
  const projects = []
  for (const name of names) {
    projects.push({
      id: `id-${name}`,
      name,
      slug: name,
      cwd: await candidate(name),
      presets: [],
      activeTabId: null,
    })
  }
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ version: 5, projects, tabs: [], activeProjectId, activeTabId: null }),
    'utf8',
  )
}

const tabRows = (page: Page): ReturnType<Page['locator']> => page.locator('[data-testid^="stab-"]')

/** The sidebar's rows, top to bottom, by testid. */
async function orderOf(page: Page, prefix: string): Promise<(string | undefined)[]> {
  return page
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.testid))
}

/**
 * Open a tab in the active project through the File menu.
 *
 * Retried once: the renderer registers `onMenuCommand` inside an effect, and a
 * send that arrives before that effect has run is dropped silently on both
 * sides. Waiting for the pane area first is what usually makes the first click
 * land; the retry is for when it does not.
 */
async function openTab(app: ElectronApplication, page: Page): Promise<void> {
  const before = await tabRows(page).count()
  await expect(page.getByTestId('terminal-column')).toBeVisible()
  const click = (): Promise<void> =>
    app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('new-tab')?.click()
    })
  await click()
  try {
    await expect(tabRows(page)).toHaveCount(before + 1, { timeout: 10_000 })
  } catch {
    await click()
    await expect(tabRows(page)).toHaveCount(before + 1, { timeout: 20_000 })
  }
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
}

/**
 * One HTML5 drag, from `source` onto the named half of `target`.
 *
 * The three events share one `DataTransfer`, the way a real drag session does,
 * and `dragover` is what the handler answers with `preventDefault`: without it
 * the browser refuses the drop and `drop` never fires at all. So a broken
 * `onDragOver` shows up here as an unmoved list, not as an error.
 */
async function dragOnto(
  page: Page,
  sourceTestid: string,
  targetTestid: string,
  half: 'top' | 'bottom',
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const source = page.getByTestId(sourceTestid)
  const target = page.getByTestId(targetTestid)
  const box = await target.boundingBox()
  if (box === null) throw new Error(`no box for ${targetTestid}`)
  const clientY = box.y + box.height * (half === 'top' ? 0.25 : 0.75)
  // `project-id-beta` and `stab-<paneId>` both carry the id the line is keyed
  // on after their prefix.
  const lineId = targetTestid.replace(/^(project|stab)-/, '')

  await source.dispatchEvent('dragstart', { dataTransfer })
  await target.dispatchEvent('dragover', { dataTransfer, clientY })
  // The line the user is aiming at, asserted mid-drag because that is the only
  // moment it exists. Its `data-place` is the half the pointer is in, and a
  // drop landing somewhere other than where the line was drawn is the failure
  // this feature is most likely to have.
  await expect(page.getByTestId(`drop-line-${lineId}`)).toHaveAttribute(
    'data-place',
    half === 'top' ? 'before' : 'after',
  )
  await target.dispatchEvent('drop', { dataTransfer, clientY })
  await source.dispatchEvent('dragend', { dataTransfer })
  // Nothing left behind: the line is drawn only while a drag is in flight.
  await expect(page.locator('[data-testid^="drop-line-"]')).toHaveCount(0)
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-sidebar-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-sidebar-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-sidebar-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-sidebar-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }), 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-sidebar-claude-'))
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

// Beta and Gamma are the second and third projects on disk and the first two
// rows on screen, so every number here is wrong under the old rule and right
// under the new one. Alpha is the control: dormant, last, and still numbered.
test('numbers the rows it draws, and ⌘n selects the row it numbered', async () => {
  await seed(['alpha', 'beta', 'gamma'], 'id-alpha')
  const app = await launch()
  const page = await app.firstWindow()

  await page.getByTestId('project-id-beta').click()
  await openTab(app, page)
  await page.getByTestId('project-id-gamma').click()
  await openTab(app, page)

  expect(await orderOf(page, 'project-')).toEqual([
    'project-id-beta',
    'project-id-gamma',
    'project-id-alpha',
  ])
  await expect(page.getByTestId('project-id-beta')).toContainText('⌘1')
  await expect(page.getByTestId('project-id-gamma')).toContainText('⌘2')
  await expect(page.getByTestId('project-id-alpha')).toContainText('⌘3')

  await page.keyboard.press('Meta+Digit1')
  await expect(page.getByTestId('project-id-beta')).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Meta+Digit3')
  await expect(page.getByTestId('project-id-alpha')).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Meta+Digit2')
  await expect(page.getByTestId('project-id-gamma')).toHaveAttribute('data-active', 'true')

  await app.close()
})

test('drags a project above another, and renumbers both', async () => {
  await seed(['alpha', 'beta'], 'id-alpha')
  const app = await launch()
  const page = await app.firstWindow()

  await openTab(app, page)
  await page.getByTestId('project-id-beta').click()
  await openTab(app, page)

  expect(await orderOf(page, 'project-')).toEqual(['project-id-alpha', 'project-id-beta'])
  await dragOnto(page, 'project-id-beta', 'project-id-alpha', 'top')

  await expect
    .poll(() => orderOf(page, 'project-'))
    .toEqual(['project-id-beta', 'project-id-alpha'])
  await expect(page.getByTestId('project-id-beta')).toContainText('⌘1')
  await expect(page.getByTestId('project-id-alpha')).toContainText('⌘2')
  // The number is not decoration: the key has to have moved with it.
  await page.keyboard.press('Meta+Digit1')
  await expect(page.getByTestId('project-id-beta')).toHaveAttribute('data-active', 'true')

  await app.close()
})

// The one that needed a new channel: tab order is a position in one flat array
// every project shares, so this is also the test that a relaunch reads back
// what the drag wrote.
test('drags a tab inside its project, and the order survives a relaunch', async () => {
  await seed(['alpha'], 'id-alpha')
  const app = await launch()
  const page = await app.firstWindow()

  await openTab(app, page)
  await openTab(app, page)
  const before = await orderOf(page, 'stab-')
  expect(before).toHaveLength(2)

  await dragOnto(page, before[0] as string, before[1] as string, 'bottom')
  await expect.poll(() => orderOf(page, 'stab-')).toEqual([before[1], before[0]])

  await app.close()
  const relaunched = await launch()
  const second = await relaunched.firstWindow()
  await expect(tabRows(second)).toHaveCount(2)
  await expect.poll(() => orderOf(second, 'stab-')).toEqual([before[1], before[0]])
  await relaunched.close()
})

test('closes a tab from its own sidebar row', async () => {
  await seed(['alpha'], 'id-alpha')
  const app = await launch()
  const page = await app.firstWindow()

  await openTab(app, page)
  await openTab(app, page)
  const [first] = await orderOf(page, 'stab-')
  const paneId = (first as string).slice('stab-'.length)

  // The button exists on every row now, not just Unsorted's. It is hidden by
  // opacity until the row is hovered, which Playwright's click does for us,
  // and which is also why this asserts on the row count rather than on the
  // button being "visible": an `opacity-0` element is visible to Playwright.
  await page.getByTestId(`sclose-${paneId}`).click()
  await expect(tabRows(page)).toHaveCount(1)
  await expect(page.getByTestId(first as string)).toHaveCount(0)

  await app.close()
})
