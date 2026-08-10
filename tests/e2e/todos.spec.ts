/**
 * The TODOS column's list: what a seeded `todos.json` renders, and what the
 * search box, the two filters and the row's hover action do to it.
 *
 * A fresh spec file with its own page and its own socket, so no earlier file's
 * typing makes an assertion here vacuous. Within the file the tests share one
 * page, so every test that changes a filter or the list itself puts it back
 * before it finishes: a count assertion in a later test would otherwise be
 * measuring this one's leftovers.
 *
 * The list is seeded on disk rather than created through the modal, which is
 * `todoModal.spec.ts`'s job. Nothing here writes a todo, so the modal never
 * opens.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'
import { parseRgb } from './colour'

const SOCKET = 'pterm-e2e-todos'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

/**
 * Three todos: two open and one already done, so `2 open` is a number the
 * count has to compute rather than a row tally. `chase invoice` is the only
 * high one, which is what puts it first under the default priority sort and
 * what makes its dot the danger token. `book flights` is the only low one and
 * the only one whose text contains "flights", so the priority filter and the
 * search box each narrow to exactly one row.
 */
const SEEDED = [
  {
    id: 'td_seed0001',
    title: 'chase invoice',
    body: '',
    priority: 'high',
    done: false,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'td_seed0002',
    title: 'book flights',
    body: 'Lisbon, October',
    priority: 'low',
    done: false,
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
  },
  {
    id: 'td_seed0003',
    title: 'renew the domain',
    body: '',
    priority: 'medium',
    done: true,
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-02T09:00:00.000Z',
  },
]

/** Every row currently in the list, and nothing else in it. */
function rows(target: Page) {
  return target.getByTestId('todos-list').locator('button[data-testid^="todo-row-"]')
}

/** The id out of the first row's own testid, which is where the id is kept. */
async function firstRowId(target: Page): Promise<string> {
  const first = rows(target).first()
  await expect(first).toBeVisible()
  const testid = await first.getAttribute('data-testid')
  if (testid === null) throw new Error('the first todo row carries no data-testid')
  return testid.replace('todo-row-', '')
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-todos-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-todos-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-todos-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-todos-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-todos-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  await mkdir(alphaCwd, { recursive: true })

  // One project. The column is global and takes none, but the window still
  // wants a workspace to open on. `slug` is required: `isProject`
  // (src/main/state/store.ts) silently drops a row without one.
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

  await writeFile(join(configDir, 'todos.json'), JSON.stringify({ version: 1, todos: SEEDED }))

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

test('shows the seeded todos, highest priority first', async () => {
  await expandColumn(page, 'todos')
  // Two of the three are open, so this is the count doing arithmetic rather
  // than reporting how many rows it drew.
  await expect(page.getByTestId('todos-count')).toHaveText('2 open')
  const titles = await rows(page).allInnerTexts()
  expect(titles[0]).toContain('chase invoice')
})

test('search narrows the list', async () => {
  await expandColumn(page, 'todos')
  await page.getByTestId('todos-search').fill('flights')
  await expect(rows(page)).toHaveCount(1)
  // Cleared before the next test: this file shares one page, so a filter left
  // set would make a later count assertion mean something else entirely.
  await page.getByTestId('todos-search').fill('')
  await expect(rows(page)).toHaveCount(2)
})

test('the priority filter excludes other levels', async () => {
  await expandColumn(page, 'todos')
  await page.getByTestId('todos-priority-low').click()
  await expect(rows(page)).toHaveCount(1)
  await page.getByTestId('todos-priority-all').click()
  await expect(rows(page)).toHaveCount(2)
})

test('the hover action marks a todo done and the Done filter finds it', async () => {
  await expandColumn(page, 'todos')
  const id = await firstRowId(page)
  await page.getByTestId(`todo-done-${id}`).click()
  await expect(page.getByTestId('todos-list').locator(`[data-testid="todo-row-${id}"]`)).toHaveCount(0)
  await page.getByTestId('todos-state-done').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toBeVisible()

  // Put the todo back, not just the filter. This is the only test here that
  // changes the LIST, and the next one reads the first row under the default
  // sort: left done, that row would be a different todo at a different
  // priority, and the assertion below would be about the wrong colour.
  await page.getByTestId(`todo-done-${id}`).click()
  await expect(page.getByTestId('todos-list').locator(`[data-testid="todo-row-${id}"]`)).toHaveCount(0)
  await page.getByTestId('todos-state-open').click()
  await expect(page.getByTestId('todos-count')).toHaveText('2 open')
})

test('the priority dot is drawn in the theme token, not a literal', async () => {
  await expandColumn(page, 'todos')
  const id = await firstRowId(page)
  const colour = await page
    .getByTestId(`todo-dot-${id}`)
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim(),
  )
  expect(parseRgb(colour)).toBe(token)
})
