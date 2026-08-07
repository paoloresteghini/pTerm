/**
 * Resizing the side columns: the drag itself, the floor it stops at, that one
 * column's drag leaves its neighbours alone, and that the width comes back
 * after a relaunch.
 *
 * A fresh spec file with its own page. The tests share it and run in order:
 * the width one test drags to is the width the next asserts survived.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-columns'

/** `COLUMN_WIDTH_DEFAULT` and `COLUMN_WIDTH_MIN` in `lib/columnWidth.ts`. */
const DEFAULT_WIDTH = 208
const MIN_WIDTH = 140

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

/** One column's rendered width, which is the quantity a drag is for. */
async function widthOf(target: Page, testid: string): Promise<number> {
  const box = await target.getByTestId(testid).boundingBox()
  if (!box) throw new Error(`${testid} has no box`)
  return box.width
}

/**
 * Drag a resize handle by `dx` pixels.
 *
 * Stepped rather than a single jump, because the component reads `clientX` off
 * every `pointermove`: a one-step drag would exercise a single event and say
 * nothing about a gesture. `steps` also gives the renderer frames to paint,
 * which is what the assertions read.
 */
async function dragHandle(target: Page, testid: string, dx: number): Promise<void> {
  const box = await target.getByTestId(testid).boundingBox()
  if (!box) throw new Error(`${testid} has no box`)
  const y = box.y + box.height / 2
  await target.mouse.move(box.x + box.width / 2, y)
  await target.mouse.down()
  await target.mouse.move(box.x + box.width / 2 + dx, y, { steps: 10 })
  await target.mouse.up()
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-columns-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-columns-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-columns-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-columns-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-columns-claude-'))
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

test('a left column follows the pointer right, and a right column follows it left', async () => {
  // The sign is the one thing that differs between the two sides, and a
  // component that got it backwards would still resize — in the wrong
  // direction, growing when the user asked for smaller. One assertion per side
  // is what makes that a failure rather than a preference.
  await expandColumn(page, 'files')
  expect(await widthOf(page, 'files-panel')).toBe(DEFAULT_WIDTH)
  await dragHandle(page, 'resize-files', 60)
  await expect.poll(() => widthOf(page, 'files-panel')).toBe(DEFAULT_WIDTH + 60)

  await expandColumn(page, 'skills')
  expect(await widthOf(page, 'skills-panel')).toBe(DEFAULT_WIDTH)
  // Left, and the column gets WIDER: its handle is on its inner edge.
  await dragHandle(page, 'resize-skills', -50)
  await expect.poll(() => widthOf(page, 'skills-panel')).toBe(DEFAULT_WIDTH + 50)
})

test('dragging one column leaves its neighbours where they were', async () => {
  // The failure this rules out is a shared width, which would look right in
  // any single-column test: drag one, all move.
  const filesBefore = await widthOf(page, 'files-panel')
  const skillsBefore = await widthOf(page, 'skills-panel')
  const sidebarBefore = await widthOf(page, 'sidebar')

  await dragHandle(page, 'resize-sidebar', 40)
  await expect.poll(() => widthOf(page, 'sidebar')).toBe(sidebarBefore + 40)
  expect(await widthOf(page, 'files-panel')).toBe(filesBefore)
  expect(await widthOf(page, 'skills-panel')).toBe(skillsBefore)
})

test('a drag past the floor stops at it rather than closing the column', async () => {
  // 2000px is far past anything the window allows, so this also proves the
  // gesture keeps tracking after the clamp binds instead of ending there.
  await dragHandle(page, 'resize-skills', 2000)
  await expect.poll(() => widthOf(page, 'skills-panel')).toBe(MIN_WIDTH)
  // Still a column, not a strip: the floor is a width, not a collapse.
  await expect(page.getByTestId('skills-panel')).toBeVisible()
  await expect(page.getByTestId('skills-filter')).toBeVisible()
})

test('the widths come back after a relaunch', async () => {
  const files = await widthOf(page, 'files-panel')
  const sidebar = await widthOf(page, 'sidebar')
  expect(files).not.toBe(DEFAULT_WIDTH)
  expect(sidebar).not.toBe(DEFAULT_WIDTH)

  await app.close()
  app = await launch()
  page = await app.firstWindow()

  // The sidebar never collapses, so it is measurable immediately; files has to
  // be waited for like any other restored column.
  await expect.poll(() => widthOf(page, 'sidebar')).toBe(sidebar)
  await expect(page.getByTestId('files-panel')).toBeVisible()
  expect(await widthOf(page, 'files-panel')).toBe(files)
  // And the one held at the floor came back at the floor, not at the default.
  await expect(page.getByTestId('skills-panel')).toBeVisible()
  expect(await widthOf(page, 'skills-panel')).toBe(MIN_WIDTH)
})
