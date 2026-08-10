/**
 * The todo modal's write path: create, edit, delete behind its confirm, and
 * the close-time state reset that stops one session's body being mounted into
 * the next.
 *
 * Its own page and its own socket, so no earlier file's typing makes an
 * assertion here vacuous. The config dir starts EMPTY of `todos.json`, which is
 * what makes the create path the thing that puts the first row on screen: a
 * seeded list would let every test below pass without create working at all.
 *
 * The tests run in order and share the list they build, so each one says what
 * it leaves behind.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-todomodal'

let app: ElectronApplication | undefined
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

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

/**
 * Fire the View menu's "Todos" item by id, the way a click on the real menu
 * bar would. Driven through the main process, because Playwright cannot
 * reach the macOS menu bar, the same approach `menuColumns.spec.ts` uses.
 */
async function clickToggleTodos(): Promise<void> {
  await app?.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('toggle-todos')?.click()
  })
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-todomodal-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-todomodal-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-todomodal-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-todomodal-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-todomodal-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  await mkdir(alphaCwd, { recursive: true })

  // One project, and no `todos.json`. `slug` is required: `isProject`
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

test('creates a todo from the column, at the priority picked', async () => {
  await expandColumn(page, 'todos')
  await expect(page.getByTestId('todos-empty-list')).toHaveText('No todos.')

  await page.getByTestId('todos-new').click()
  await expect(page.getByTestId('todo-title-input')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('todo-title-input').fill('chase invoice')
  await page.getByTestId('todo-priority-high').click()
  await page.getByTestId('todo-save').click()

  await expect(page.getByTestId('todos-count')).toHaveText('1 open')
  await expect(page.getByTestId('todos-list')).toContainText('chase invoice')

  // The priority the picker was clicked on has to have travelled with the
  // create, not merely coloured the button: the read view's chip is where the
  // stored record says what it is.
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await expect(page.getByTestId('todo-priority')).toContainText('High')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
})

test('edits the title and the row follows', async () => {
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-edit').click()
  await page.getByTestId('todo-title-input').fill('chase invoice twice')
  await page.getByTestId('todo-save').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toContainText('chase invoice twice')

  // Saving an edit drops back to read mode rather than closing, so the modal
  // has to be dismissed before the next test can click a row behind it.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
})

test('a new create does not inherit the previous body', async () => {
  // The regression this file exists for, and the defect `IssueModal` shipped:
  // `BodyEditor` builds once from the value at mount, so a close that left the
  // state populated showed the previous todo's body over empty state, and
  // Create then filed the empty version. Reading the EDITOR here, not the
  // state, is what makes the assertion mean anything.
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-edit').click()
  await expect(page.getByTestId('todo-body-editor')).toBeVisible({ timeout: 15_000 })
  // Clicked and typed rather than filled, which is how every other spec in
  // this suite drives a CodeMirror document.
  await page.getByTestId('todo-body-editor').locator('.cm-content').click()
  await page.keyboard.type('some context')

  // Out through the confirm, which is the path the broken version left half
  // done.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirm-close')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('confirm-close-discard').click()
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
  // The confirm must not come back on its own once the modal is gone.
  await expect(page.getByTestId('confirm-close')).toHaveCount(0)

  await page.getByTestId('todos-new').click()
  await expect(page.getByTestId('todo-body-editor')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('todo-body-editor').locator('.cm-content')).toHaveText('')
  await expect(page.getByTestId('todo-title-input')).toHaveValue('')

  // Nothing was typed into this draft, so it closes without a confirm.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
})

test('delete asks first, then removes the row', async () => {
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-delete').click()
  // Still there: the first click asks, it does not delete.
  await expect(page.getByTestId(`todo-row-${id}`)).toBeVisible()
  await page.getByTestId('todo-delete-confirm').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
})

test('hiding the column while a draft is open clears the draft, so showing it again does not reopen it', async () => {
  await expandColumn(page, 'todos')
  await page.getByTestId('todos-new').click()
  // Autofocus lands in the title field, which carries `data-shortcuts="off"`
  // and would swallow a keyboard shortcut, so this drives the View menu item
  // instead: the other of the two paths that hide the column, and the one
  // the draft's own focus cannot block.
  await expect(page.getByTestId('todo-title-input')).toBeVisible({ timeout: 15_000 })

  // Hides the column outright, which unmounts it (and the dialog inside it)
  // without ever calling the modal's own `onClose`. That is the path that
  // used to leave `creatingTodo` stuck at `true`.
  await clickToggleTodos()
  await expect(page.getByTestId('todos-panel')).toHaveCount(0)

  await clickToggleTodos()
  await expect(page.getByTestId('todos-panel')).toBeVisible()
  await expect(page.getByTestId('todo-modal')).toHaveCount(0)
})

test('the list survives a relaunch, and so does the column width', async () => {
  await page.getByTestId('todos-new').click()
  await page.getByTestId('todo-title-input').fill('survives')
  await page.getByTestId('todo-save').click()
  await expect(page.getByTestId('todos-list')).toContainText('survives')

  // Away from `COLUMN_WIDTH_DEFAULT` (208), so the relaunch has something to
  // prove: the default renders correctly whether or not `pterm:todosWidth`
  // was ever read back.
  await page.evaluate(() => localStorage.setItem('pterm:todosWidth', '340'))

  // Relaunched against the SAME config dir, which is what makes this a test of
  // `todos.json` rather than of React state. The temp dirs are the ones
  // `beforeAll` created; nothing here allocates new ones, or the list would be
  // empty for an uninteresting reason.
  await app?.close()
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()

  // Read directly rather than through `expandColumn`: that helper opens the
  // column itself when it finds one hidden or collapsed, which would make
  // this pass whether or not the hidden/collapsed flags were restored. Every
  // earlier test in this file leaves the column shown, so it must already be
  // on screen here if `pterm:todosHidden` and `pterm:todosCollapsed` were
  // actually read back.
  await expect(page.getByTestId('titlebar')).toBeVisible()
  const panel = page.getByTestId('todos-panel')
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  expect(Math.round(box!.width)).toBe(340)
  await expect(page.getByTestId('todos-list')).toContainText('survives')
})
