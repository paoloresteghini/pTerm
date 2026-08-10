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
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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
  // Before the `rm` below, because the last test makes `configDir` read-only
  // to force a write failure. A test that aborts between the two `chmod`s
  // leaves it that way, and `rm` then fails with EACCES on the subdirectories
  // the app created inside it: measured, the temp dir leaked and teardown
  // threw on top of the real failure.
  await chmod(configDir, 0o700).catch(() => undefined)
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

test('a failed write says so, and the next successful read clears it', async () => {
  await expandColumn(page, 'todos')
  const id = await firstRowId(page)

  // The config dir made read-only, so the store's atomic write cannot create
  // the temp file it renames into place. Nothing in the app is stubbed for
  // this: the rejection travels the real path, from `writeFile`'s EACCES
  // through `ipcMain.handle` to the panel's own `catch`.
  await chmod(configDir, 0o500)
  await page.getByTestId(`todo-done-${id}`).click()
  await expect(page.getByTestId('todos-error')).toHaveText('Writing the todo list failed.')
  // The row staying put is on its own indistinguishable from a click that
  // never landed, which is why the message above has to exist.
  await expect(page.getByTestId(`todo-row-${id}`)).toBeVisible()

  // Restored, and the error goes with the next load rather than sitting there
  // over a column that is working again. This puts both the permissions and
  // the list back regardless of what runs after it.
  await chmod(configDir, 0o700)
  await page.getByTestId('todos-refresh').click()
  await expect(page.getByTestId('todos-error')).toHaveCount(0)
  await expect(page.getByTestId('todos-count')).toHaveText('2 open')
})

test('a successful modal mutation clears an error the list left behind', async () => {
  // The regression the first fix round introduced. The modal hands its reply
  // straight back as the new list, deliberately, since the reply carries the
  // whole thing; the error state was not on that path, so a stale write failure
  // sat over a list a later edit had already put right.
  await expandColumn(page, 'todos')
  const id = await firstRowId(page)

  await chmod(configDir, 0o500)
  await page.getByTestId(`todo-done-${id}`).click()
  await expect(page.getByTestId('todos-error')).toHaveText('Writing the todo list failed.')
  await chmod(configDir, 0o700)

  // A mutation through the MODAL, not the refresh button: refresh goes through
  // `load`, which cleared the error even before the fix, so it cannot tell the
  // two versions apart.
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-edit').click()
  await page.getByTestId('todo-title-input').fill('chase invoice properly')
  await page.getByTestId('todo-save').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toContainText('chase invoice properly')
  await expect(page.getByTestId('todos-error')).toHaveCount(0)

  // Leaves that todo renamed. Both `chmod`s are balanced above, and `afterAll`
  // restores the mode again in case they are not.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
})

test('the palette can open the Todos column and start a new todo', async () => {
  // Every earlier test in this file leaves the column visible, but this test
  // must run from it hidden, the state a fresh profile launches into. Toggled
  // only if it is currently shown, with the same shortcut `expandColumn` uses,
  // so the test reaches the same starting point whether it runs after them or
  // (as when isolated with `-g`) on its own against a profile already hidden.
  if ((await page.getByTestId('todos-panel').count()) > 0) {
    await page.keyboard.press('Alt+Meta+t')
  }
  await expect(page.getByTestId('todos-panel')).toHaveCount(0)

  // "New todo" from a hidden column, with no "Toggle Todos" first: it has to
  // show the column itself, or the modal it also opens has nothing to mount
  // into.
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('todo')
  await page.getByTestId('palette-command-New todo').click()
  await expect(page.getByTestId('todos-panel')).toBeVisible()
  await expect(page.getByTestId('todo-title-input')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)

  // Hides it again and brings it back with "Toggle Todos" itself, so the
  // other command is covered too.
  await page.keyboard.press('Alt+Meta+t')
  await expect(page.getByTestId('todos-panel')).toHaveCount(0)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('todo')
  await page.getByTestId('palette-command-Toggle Todos').click()
  await expect(page.getByTestId('todos-panel')).toBeVisible()

  // Last test in the file, and it leaves the column visible, matching how
  // every earlier test here left it.
})
