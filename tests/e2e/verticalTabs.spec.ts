/**
 * The tabs column end to end: opening it takes the horizontal bar away,
 * closing it (either through the menu or by collapsing to its strip) brings
 * the bar back, a split's panes are bracketed as PEERS at one indent rather
 * than one being nested under the other, clicking either of them moves the
 * keyboard to that pane, and a row can be renamed by double-clicking its
 * label the way a tab in the bar can.
 *
 * The rename is covered HERE and not in `tabs.spec.ts` because the two
 * surfaces are never on screen together (`showsTabBar`): whichever one is up
 * is the only place a pane can be renamed from, so each needs its own end to
 * end proof rather than one standing in for both.
 *
 * Modeled on `webgl.spec.ts`'s setup: a temp-dir `beforeEach`/`afterEach`, a
 * seeded single-project config, and a private socket so this file's tmux
 * sessions never touch another spec's or the developer's own.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, terminalTextOf } from './harness'

const SOCKET = 'pterm-e2e-vtabs'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let window: Page

/** Fire a menu item by id, the way a click on the real menu bar would. */
async function clickMenuItem(id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click()
  }, id)
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-vtabs-ud-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-vtabs-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-vtabs-proj-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-vtabs-cwd-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-vtabs-cs-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, '{}', 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-vtabs-home-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-v', name: 'V', slug: 'v', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-v',
      tabs: [],
    }),
    'utf8',
  )
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  window = await app.firstWindow()
  await expect(window.getByTestId('titlebar')).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('opening the column takes the horizontal bar away, and closing it brings it back', async () => {
  // Bar first, column hidden: the default every other spec in this suite runs under.
  await expect(window.getByTestId('tabbar')).toBeVisible()
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  await expect(window.getByTestId('tabbar')).toHaveCount(0)
  // The guarantee that matters: no state leaves the workspace without a tab
  // surface. Collapsing to the strip is the other way back, covered below.
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabbar')).toBeVisible()
})

test('collapsing the column to its strip also brings the bar back', async () => {
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabbar')).toHaveCount(0)
  await window.getByTestId('tabs-heading').click()
  await expect(window.getByTestId('tabs-toggle')).toBeVisible()
  await expect(window.getByTestId('tabbar')).toBeVisible()
})

test('a split brackets its panes as peers, not one nested under the other', async () => {
  // The bar, not the column, holds `new-tab`: the column has nowhere to put
  // it, so the first pane is opened before the column replaces the bar.
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  const first = (await window.locator('[data-testid^="vpane-"]').getAttribute('data-testid'))!.slice(
    'vpane-'.length,
  )
  // Before the split there is one pane, so nothing to bracket.
  await expect(window.locator('[data-testid^="vpane-"]')).toHaveCount(1)
  await expect(window.getByTestId(`vpane-${first}`)).not.toHaveAttribute('data-bracket', /.*/)

  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  // Two rows, both panes, at ONE indent and joined by a bracket. Neither is a
  // child of the other: that is what this column says about a split that the
  // bar cannot, and drawing one indented under the first claimed a containment
  // that does not exist.
  const rows = window.locator('[data-testid^="vpane-"]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-bracket', 'first')
  await expect(rows.nth(1)).toHaveAttribute('data-bracket', 'last')

  // Same left edge, which is the visible half of "peers": a parent-and-child
  // shape indents the second row, and this is how that regresses loudly.
  //
  // Measured on the row's first CHILD, not the row. The rows are full-width
  // flex items, so indenting one with `padding-left` moves its content while
  // its own box keeps the same x. Measured 2026-08-09: an assertion over
  // `el.getBoundingClientRect().x` stayed green against a deliberate 12px
  // indent, which is exactly the vacuous-assertion shape this suite has been
  // bitten by before.
  const contentX = await rows.evaluateAll((els) =>
    els.map((el) => el.firstElementChild!.getBoundingClientRect().x),
  )
  expect(contentX[0]).toBeCloseTo(contentX[1] as number, 1)

  // The pane that was there before the split is still one of the two.
  await expect(window.getByTestId(`vpane-${first}`)).toBeVisible()
})

test('double-clicking a row renames the pane, and survives a relaunch', async () => {
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  const id = (await window.locator('[data-testid^="vpane-"]').getAttribute('data-testid'))!.slice(
    'vpane-'.length,
  )

  // The label, not the row: the row's own double-click does nothing, which is
  // what made this column's panes unrenameable while the bar's were not.
  await window.getByTestId(`vlabel-${id}`).dblclick()
  const field = window.getByTestId(`vinput-${id}`)
  await field.fill('payments api')
  await field.press('Enter')
  await expect(window.getByTestId(`vlabel-${id}`)).toContainText('payments api')

  // The half no unit test reaches: the name has to be on disk and come back
  // through restore, not merely live in the renderer's state. Asserted in this
  // column rather than the bar, since the column is what restore reopens on.
  await app.close()
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  window = await app.firstWindow()
  await expect(window.getByTestId(`vlabel-${id}`)).toContainText('payments api', {
    timeout: 20_000,
  })

  // Blank clears it, back to the slug-and-id default `tabLabel` computes.
  await window.getByTestId(`vlabel-${id}`).dblclick()
  const again = window.getByTestId(`vinput-${id}`)
  await again.fill('')
  await again.press('Enter')
  await expect(window.getByTestId(`vlabel-${id}`)).toContainText(id.slice(0, 6))
})

test('Escape abandons a rename in the column instead of committing it', async () => {
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  const id = (await window.locator('[data-testid^="vpane-"]').getAttribute('data-testid'))!.slice(
    'vpane-'.length,
  )

  await window.getByTestId(`vlabel-${id}`).dblclick()
  const field = window.getByTestId(`vinput-${id}`)
  await field.fill('discarded')
  await field.press('Escape')
  // Both halves: the field is gone, and what it held was not kept. `editing`
  // is the ref that makes the second true: without it, the blur that follows
  // the unmount commits the draft Escape was pressed to throw away.
  await expect(window.getByTestId(`vinput-${id}`)).toHaveCount(0)
  await expect(window.getByTestId(`vlabel-${id}`)).not.toContainText('discarded')
  await expect(window.getByTestId(`vlabel-${id}`)).toContainText(id.slice(0, 6))
})

test('clicking a split\'s other pane moves the keyboard to it', async () => {
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  const first = (await window.locator('[data-testid^="vpane-"]').getAttribute('data-testid'))!.slice(
    'vpane-'.length,
  )
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // The sibling is whichever of the two rows is not the pane that was already
  // there. Both rows carry the same testid prefix now that neither is a child.
  const ids = await window
    .locator('[data-testid^="vpane-"]')
    .evaluateAll((els) =>
      els.map((el) => ((el as HTMLElement).dataset.testid ?? '').slice('vpane-'.length)),
    )
  const siblingId = ids.find((id) => id !== first)!
  expect(siblingId).toBeDefined()
  // A split hands the keyboard straight to the new pane, so the sibling is
  // already the one selected. Selecting the other row first is what makes the
  // click below a real move rather than a click on what is already active:
  // measured, a click that lands on an already-active row still steals real
  // DOM focus (to the row's own div) without anything putting it back, so
  // this test would pass for the wrong reason without this step.
  await window.getByTestId(`vpane-${first}`).click()
  await window.getByTestId(`vpane-${siblingId}`).click()

  // Wait for the keyboard to actually arrive before typing at it. Clicking a
  // row moves DOM focus to the row's own div; what puts it back into the
  // terminal is `Terminal.tsx`'s focused-prop effect, which runs a render
  // later. Typing in between sends the keystrokes to the row, and the poll
  // below cannot recover them, so the test fails claiming the wrong pane got
  // the text. Observed flaking exactly that way on 2026-08-09, which is the
  // condition the branch that wrote this test set for adding this wait.
  await expect
    .poll(async () =>
      window.evaluate(
        (id) => document.querySelector(`[data-testid="pane-${id}"]`)?.contains(document.activeElement) ?? false,
        siblingId,
      ),
    )
    .toBe(true)

  // Typed text has to land in the pane that was clicked, not merely in some
  // pane or other: read that pane's own buffer by id, because a count over
  // every pane's text (as `terminalTexts` returns it) cannot tell the row that
  // was clicked apart from the one clicked immediately before it, and a `row`
  // that selected the wrong pane would still leave exactly one pane holding
  // the marker.
  await window.keyboard.type('echo vtabs-target')
  await expect.poll(async () => terminalTextOf(window, siblingId)).toContain('vtabs-target')
  // And the other pane must NOT have caught it, which is the other half of
  // "landed in the right pane" rather than just "landed somewhere".
  await expect.poll(async () => terminalTextOf(window, first)).not.toContain('vtabs-target')
})

