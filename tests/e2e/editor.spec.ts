/**
 * Clicking a file in the tree, and the pane that opens.
 *
 * The first thing in this slice with anything on screen. Everything asserted
 * here is the rendered result of a real click: the tab that appears, the file's
 * own text inside the pane, and what a pane whose file has gone says instead.
 *
 * `beforeAll`/`afterAll` with one app and one `page` for the whole file, like
 * `filetree.spec.ts` and unlike `editorRestore.spec.ts`'s per-test temp dirs.
 * These tests are a sequence (the second reads the tab the first opened), so a
 * fresh app per test would have to re-do the click anyway, and the last test
 * needs a pane that was opened through the UI before it reloads the window.
 * A `-g` filtered run of one test here proves nothing; believe the whole-file
 * run.
 *
 * **One failure in this file invalidates every test after it, and the reason is
 * not obvious.** Playwright restarts the worker process after a failed test, so
 * `beforeAll` runs AGAIN for the remaining tests: fresh temp dirs, a fresh
 * config, a fresh app with no panes in it. Measured 2026-08-04, when the third
 * test failed on a locator and the fourth then failed too, on a workspace whose
 * seeded `config.json` had never been written to. Logging `configDir` in
 * `beforeAll` is what showed it, printing two different directories in one run.
 * So when a run reds more than one test here, fix the FIRST and re-run before
 * reading anything into the others.
 *
 * **Mutation measured 2026-08-04**: `FileTree.tsx`'s `toggle` changed to return
 * for a file row without calling `onOpenFile`, leaving everything else in place.
 * All 4 tests FAILED, the first at the tab bar's `README.md` with `element(s)
 * not found`, and the rest downstream of it per the paragraph above. Reverted
 * after measuring; `git diff src/renderer/FileTree.tsx` then showed only this
 * task's own change, with no residue of the mutation.
 *
 * **Reload mechanism measured 2026-08-04**: the last test's `page.reload()` is
 * what re-reads the file, and it was verified by removing it rather than
 * assumed. With the line deleted and nothing else changed, the first three
 * tests passed and the fourth FAILED at `editor-missing`, because the pane goes
 * on rendering the text it fetched when it mounted. `page.reload()` remounts the
 * renderer, `restore()` brings the sessionless pane back, and `FileView`'s mount
 * effect calls `fsRead` again, which now answers null.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, expandColumn } from './harness'
import { UNSORTED_ID } from '../../src/shared/ipc'

const SOCKET = 'pterm-e2e-editor'

/** Seeded as both `src/app.ts` and `notes.txt`. See `beforeAll`. */
const TYPESCRIPT_BYTES = 'export const answer = 42\n'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-editor-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-editor-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-editor-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-editor-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-editor-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(join(projectCwd, 'src'), { recursive: true })
  await writeFile(join(projectCwd, 'src', 'app.ts'), TYPESCRIPT_BYTES)
  // The same bytes under a name no grammar claims, which is the control for
  // the syntax highlighting test: written from one constant rather than two
  // literals so the two files cannot drift apart and quietly turn that test
  // into a comparison of two different documents.
  await writeFile(join(projectCwd, 'notes.txt'), TYPESCRIPT_BYTES)
  await writeFile(join(projectCwd, 'README.md'), '# demo\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 8,
      // `slug` is required: `isProject` drops a project row without one,
      // silently, and the tree then has no project to read.
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      // Nothing seeded. Every pane and every tab row in this file is one the
      // click created, which is what separates it from `editorRestore.spec.ts`.
      panes: [],
      tabs: [],
      activeProjectId: 'p1',
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
  page = await app.firstWindow()
  // Both columns this file drives start collapsed on a fresh profile: the
  // tree it opens files from, and the presets column one test launches a
  // claude tab out of.
  await expandColumn(page, 'files')
  await expandColumn(page, 'presets')
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clicking a file opens a tab named for it', async () => {
  await page.getByTestId('tree-row-README.md').click({ timeout: 10_000 })

  // Named for the file, through the one label rule rather than around it.
  //
  // Scoped to the tab bar rather than asserted over the whole page. The plan
  // wrote this as a bare `getByText('README.md', { exact: true })`, which
  // matches three elements once the tab exists (the tree row that was just
  // clicked, the tab bar's label, and the sidebar's own row for the tab, all
  // three of which render exactly that string), and a multi-match locator is a
  // strict-mode error, not a pass. The tab bar is the one of the three that
  // only holds the string if a tab was actually opened for the file.
  await expect(page.getByTestId('tabbar').getByText('README.md', { exact: true })).toBeVisible({
    timeout: 10_000,
  })
})

// Scoped to the visible group, here and below, rather than to the page. Every
// pane in the workspace stays mounted whatever tab is on screen. A hidden
// group is `invisible`, never unmounted, so its xterm keeps its scrollback,
// which means a bare `getByTestId('editor-content')` matches one element per
// editor tab open. The plan wrote these unscoped, and the third test below
// failed on the second tab with a strict-mode violation naming both panes. The
// scope is also the stronger assertion: the file's text is in the pane the user
// is actually looking at, not merely somewhere in the DOM.
const visiblePane = (): ReturnType<Page['getByTestId']> => page.getByTestId('terminal-active')

test('the pane shows the file contents', async () => {
  await expect(visiblePane().getByTestId('editor-content')).toContainText('# demo')
})

// The fourth caller of `tabLabel`, alongside the bar, the sidebar and a dead
// pane's chrome. `tabs.spec.ts` pins this for a terminal tab; nothing pinned
// it for an editor one, whose label comes from a file's basename instead of
// a slug and id.
test('the command palette names an editor tab the way the tab bar does', async () => {
  const editorTab = await tabIdFor('README.md')
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId(`palette-session-${editorTab}`)).toContainText('README.md')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toBeHidden()
})

// A second file gets a second tab, which is this slice's ruling: one tab per
// file, rather than one editor tab that swaps its contents.
test('a second file opens a second tab', async () => {
  const before = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('tree-row-src').click()
  await page.getByTestId('tree-row-src/app.ts').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(before + 1)
  await expect(visiblePane().getByTestId('editor-content')).toContainText(
    'export const answer = 42',
  )
})

/**
 * The two tests below sit HERE rather than at the end of the file, which is
 * where the plan put them, and both positions are forced.
 *
 * Not after the last test: it removes the project, which sends every pane to
 * Unsorted and leaves no tree to click a file in. Not after the next test
 * either: that one deletes `src/app.ts`, and the highlighted half of the pair
 * needs it. So they go after the tab `src/app.ts` opened and before it is
 * taken away.
 *
 * Neither test may re-click a tree row for a file that is already open.
 * `openEditor` mints a fresh pane and a fresh tab on every call (there is no
 * dedup by path), so a second click on `README.md` would put a second tab of
 * that name in the bar, and `tabIdFor` below is a strict-mode locator that
 * would then match two elements and fail three later tests. Clicking the
 * existing TAB is how you get back to a file.
 */

// Deliberately says nothing about disk, even though ⌘S now writes: this is the
// keystroke reaching the document and nothing else. What typing then goes on to
// do is `Cmd+S writes the file and clears the dot`'s to assert, and it reads
// the bytes rather than the screen.
test('the editor takes typing', async () => {
  const content = visiblePane().getByTestId('editor-content')
  await expect(content).toContainText('export const answer = 42', { timeout: 10_000 })

  // `.cm-content` clicked directly, and never `toBeVisible` on the pane: this
  // project has had a `toBeVisible` pass on an element painted behind the
  // terminal, so the click is the assertion. It has to land on the editable
  // element for the keystroke to have anywhere to go.
  await content.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('X')

  // Both halves. The first alone would pass if typing had replaced the
  // document, and the second alone would pass if the keystroke had gone
  // nowhere and `X` had come from somewhere else on the page.
  await expect(content).toContainText('X')
  await expect(content).toContainText('export const answer = 42')
})

/**
 * Typing marks the tab dirty, and undoing back to what was read clears it.
 *
 * Switches to the existing README tab rather than its tree row, per the note
 * above: `openEditor` mints a fresh pane per click, so a second click on an
 * already-open README would add a second tab and break `tabIdFor`'s
 * strict-mode locator for every test after this one.
 */
test('typing marks the tab dirty and undoing marks it clean', async () => {
  const paneId = await tabIdFor('README.md')
  await page.getByTestId(`tab-${paneId}`).click()
  const content = visiblePane().getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })

  await content.locator('.cm-content').click()
  await page.keyboard.type('X')
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toBeAttached()

  // Back to what was read, so the dot goes. Dirty means "differs from disk",
  // not "was typed in", and this is the assertion that tells the two apart.
  await page.keyboard.press('Meta+z')
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toHaveCount(0)

  // Back to the app.ts tab: the recolouring test right after this one reads
  // the visible pane without switching tabs first and expects that file.
  await page.getByTestId(`tab-${await tabIdFor('app.ts')}`).click()
  await expect(visiblePane().getByTestId('editor-content')).toContainText(
    'export const answer = 42',
  )
})

/**
 * Recolouring a pane must not throw away what is in its editor.
 *
 * **This pins a fix, and it caught a real defect on the way in.** The pane's
 * colour is a prop, and the first version of `FileView` had it in the view's
 * dependency array, so a recolour destroyed the `EditorView` and rebuilt it
 * from the text last read off disk. Everything typed since went with it,
 * silently, and the pane looked fine afterwards. The theme now lives in a
 * `Compartment` that is reconfigured in place instead.
 *
 * It is asserted here rather than deferred to the task that adds saving,
 * because nothing about the loss is visible: there is no error, no dirty mark
 * to go stale, just a pane that quietly says what the file used to say.
 *
 * Uses the pane's own right-click menu rather than reaching into state, which
 * is the route a user actually has. `swatch-<paneId>-<hex without #>` is the
 * same locator shape `splits.spec.ts` recolours through.
 */
test('recolouring a pane keeps what was typed into it', async () => {
  const editorTab = await tabIdFor('app.ts')
  const content = visiblePane().getByTestId('editor-content')

  await content.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('KEEPME')
  await expect(content).toContainText('KEEPME')

  await page.getByTestId(`pane-${editorTab}`).click({ button: 'right' })
  await page.getByTestId(`swatch-${editorTab}-232326`).click()

  // The recolour landed. Without this the assertions below would also pass on
  // a menu that never opened, which is the same shape of hole the pane-menu
  // test further down guards against.
  await expect(page.getByTestId(`pane-${editorTab}`)).toHaveCSS(
    'background-color',
    'rgb(35, 35, 38)',
  )

  // And the EDITOR heard about it, which the line above does not say: that
  // background is painted inline on the pane box by `App.tsx` and would be
  // right even if the compartment reconfigure did nothing at all. The gutter
  // is the one surface CodeMirror paints itself from the theme, so it is the
  // only thing on screen that can report whether the reconfigure landed.
  //
  // Measured 2026-08-05, both halves, with `themes` changed from a `useRef` to
  // a per-render `{ current: new Compartment() }` and nothing else touched:
  //
  // - with this assertion present, THIS line is where the run reds, `Expected
  //   "rgb(35, 35, 38)" Received "rgb(9, 9, 11)"`. Everything above it in this
  //   test passed, the `pane-` box assertion included, so the box really does
  //   go on reporting a recolour the editor never heard about;
  // - with this one line commented out and the mutation still in place, the
  //   whole file passed, 12 of 12. Nothing else in the suite sees it.
  //
  // A reconfigure aimed at a compartment the state has never seen is discarded
  // silently, so the editor sits on the colour it was built with.
  await expect(content.locator('.cm-gutters')).toHaveCSS('background-color', 'rgb(35, 35, 38)')

  // And the document is untouched: the typed text AND the file's own, so a
  // rebuild that happened to re-read the same file could not pass this.
  await expect(content).toContainText('KEEPME')
  await expect(content).toContainText('export const answer = 42')

  // Put it back, so the pane-menu test below opens on a pane in the state it
  // was written against.
  await page.getByTestId(`pane-${editorTab}`).click({ button: 'right' })
  await page.getByTestId(`swatch-${editorTab}-09090b`).click()
})

/**
 * A grammar was applied, asserted against the same bytes with no grammar.
 *
 * Measured 2026-08-05 rather than assumed, because the plan offered the
 * mechanism as a hypothesis. `src/app.ts` renders
 * `<span class="ͼa">export</span> <span class="ͼa">const</span> <span
 * class="ͼf">answer</span> = <span class="ͼc">42</span>`, four token spans;
 * `notes.txt`, byte for byte the same file, renders a bare `<div
 * class="cm-line">export const answer = 42</div>` with none. So the spans are
 * real and the difference is real.
 *
 * Their presence is asserted rather than their count or their classes. The
 * classes are generated names (`ͼa`) that belong to CodeMirror's own style
 * module, and the count is how the JavaScript grammar happens to tokenise one
 * line: pinning either would red on a dependency bump that broke nothing. What
 * this pins is that a language ran at all, and the plain file is what stops
 * that from being vacuous.
 */
test('a javascript file is syntax highlighted and a plain one is not', async () => {
  const highlighted = visiblePane().getByTestId('editor-content')
  await expect(highlighted).toContainText('export const answer = 42', { timeout: 10_000 })
  await expect(highlighted.locator('.cm-content span').first()).toBeAttached()

  await page.getByTestId('tree-row-notes.txt').click()
  const plain = visiblePane().getByTestId('editor-content')
  // The text first. Without it, zero spans is also what an editor that never
  // loaded looks like.
  await expect(plain).toContainText('export const answer = 42', { timeout: 10_000 })
  await expect(plain.locator('.cm-content span')).toHaveCount(0)

  // Back to the `app.ts` tab, because the next test reads the visible pane and
  // expects that file's. Its own tab rather than its tree row, per the note
  // above.
  await page.getByTestId(`tab-${await tabIdFor('app.ts')}`).click()
  await expect(visiblePane().getByTestId('editor-content')).toContainText(
    'export const answer = 42',
  )
})

// A file that is gone must say so rather than vanishing, so a moved file is
// visible rather than mysterious.
test('a file that cannot be read says so', async () => {
  await rm(join(projectCwd, 'src', 'app.ts'))
  await page.getByTestId('tree-refresh').click()
  // The tab is still open on the deleted file. Reopening it is what re-reads.
  await page.reload()
  // `visiblePane()` scopes to the ACTIVE group, so this only sees the message
  // if the `src/app.ts` tab is still the selected one after the reload. It is,
  // because `CHANNELS.setActive` writes the selection through to
  // `ProjectRecord.activeTabId` inside `serialise`, and restore hands it back:
  // the config dumped mid-run during this task's development carried
  // `"activeTabId"` naming the pane the last click selected. If that ever
  // stopped holding, this test would fail rather than pass falsely, since the
  // element would be present but in a hidden group.
  await expect(visiblePane().getByTestId('editor-missing')).toBeVisible({ timeout: 10_000 })
})

/**
 * The tab bar's id for the tab labelled `label`, which must be open.
 *
 * Read off the label span rather than tracked from the click that opened the
 * tab: the id is a pane id main minted, and the label is the one thing on
 * screen that says which file a tab is. Scoped to the tab bar because the tree
 * row and the sidebar's own row for the tab carry the same string; see the
 * first test's comment.
 */
async function tabIdFor(label: string): Promise<string> {
  const testid = await page
    .getByTestId('tabbar')
    .getByText(label, { exact: true })
    .getAttribute('data-testid')
  const id = (testid ?? '').replace('tablabel-', '')
  expect(id).not.toBe('')
  return id
}

/** Config as it stands on disk right now, the way `editorRestore.spec.ts` reads it. */
async function readConfig(): Promise<{
  panes: { id: string; type: string }[]
  tabs: { id: string; layout: { kids: string[] } }[]
}> {
  return JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
}

/**
 * The four behaviours below are what the rest of the app assumed about a pane.
 * Each was a silent wrong answer rather than a crash, except the close, which
 * was neither silent nor quiet: it painted `kill: no tmux session found for
 * tab <id>` into the pane, reported by a human running the built app.
 *
 * A claude tab is opened first and kept for the rest of the file. It is the
 * positive control for two assertions that would otherwise pass on a page with
 * nothing on it: it is the only tab here that draws a dot at all (`shell`
 * opens with no state by design, so the `+` button could not provide one), and
 * its tmux session is what the close test watches to see that closing an
 * editor kills nothing.
 */
test('a claude tab draws a dot and an editor tab does not', async () => {
  const editorTab = await tabIdFor('README.md')

  // `preset-default-claude`, the same button `status.spec.ts` uses to reach a
  // `claude` tab. It is the only kind that opens with a state, so it is the
  // only way to have a dot on screen to compare against.
  const before = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('preset-default-claude').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(before + 1, { timeout: 20_000 })
  const claudeTab = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  expect(claudeTab).not.toBe('')

  // The control. Without this the assertion below is satisfied by a locator
  // that never matches anything, which is exactly what it looks like when a
  // testid is renamed.
  await expect(page.getByTestId(`dot-${claudeTab}`)).toHaveAttribute('data-state', 'unknown', {
    timeout: 20_000,
  })

  // Scoped to the editor's own tab, not to the page: the claude tab beside it
  // legitimately has one.
  await expect(page.getByTestId(`dot-${editorTab}`)).toHaveCount(0)

  // A live tab's chrome, which is what an editor tab must always wear: one ×
  // that closes, and neither of the two buttons a tombstone puts there.
  await expect(page.getByTestId(`close-${editorTab}`)).toBeVisible()
  await expect(page.getByTestId(`restart-${editorTab}`)).toHaveCount(0)
  await expect(page.getByTestId(`dismiss-${editorTab}`)).toHaveCount(0)
})

test('closing an editor tab kills no session, and says nothing', async () => {
  const editorTab = await tabIdFor('README.md')

  // Its own shell tab, rather than reusing the claude one above: a `claude`
  // that is not installed on the machine running this exits at once, and its
  // session would then disappear between the two reads below and be blamed on
  // the close. A shell sits there.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const shellTab = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  // Polled on the session, not on the pane being drawn. Measured: the box is
  // on screen before tmux has the session, so reading the list here without
  // this waits picked up ONE session and the read after the close picked up
  // two, failing as though the close had opened something.
  await expect
    .poll(async () => (await sessionNames(SOCKET)).includes(`pterm-demo-${shellTab}`), {
      timeout: 20_000,
    })
    .toBe(true)
  const sessionsBefore = await sessionNames(SOCKET)
  // If this is ever empty the "killed nothing" assertion has nothing to be
  // about and would pass over an app that had killed everything.
  expect(sessionsBefore.length).toBeGreaterThan(0)

  await page.getByTestId(`close-${editorTab}`).click()

  // Gone from the bar. `toHaveCount(0)` rather than `not.toBeVisible()`: a tab
  // that stayed and went dead would be present and visible, and that is the
  // failure mode next door to this one.
  await expect(page.getByTestId(`tab-${editorTab}`)).toHaveCount(0, { timeout: 10_000 })

  // The defect a human hit, asserted directly. `fail` renders a rejected IPC
  // call into `startup-error`, and the message it painted was
  // `Error invoking remote method 'pterm:closePane': Error: kill: no tmux
  // session found for tab <id>`.
  await expect(page.getByTestId('startup-error')).toHaveCount(0)

  // Killed nothing. The set is compared whole rather than by length so a kill
  // AND an open in the same window could not cancel out.
  expect(await sessionNames(SOCKET)).toEqual(sessionsBefore)

  // And gone from disk, both halves: the pane row and the tab row that named
  // it. A pane row left behind comes back at the next relaunch, which is the
  // one thing this slice's restore work exists to make true in the other
  // direction.
  await expect
    .poll(
      async () => {
        const config = await readConfig()
        return {
          pane: config.panes.some((row) => row.id === editorTab),
          tab: config.tabs.some((row) => row.layout.kids.includes(editorTab)),
        }
      },
      { timeout: 10_000 },
    )
    .toEqual({ pane: false, tab: false })
})

/**
 * Closing a pane with unsaved edits asks first; closing a clean one does not.
 *
 * Placed here, between the "closing an editor tab" test above and the Cmd+S
 * test below, because it is the one window in this file where README.md is
 * both UNOPENED (the test above closed the tab test 1 opened for it) and
 * UNMODIFIED on disk: still `# demo\n`, since nothing has written to it yet.
 * The Cmd+S test below is the first thing in the file that does, so these
 * four have to run before it or the fixture their assertions rely on is
 * already gone. Every open below is by tree row, which is only safe because
 * no README tab is open going in, and each of the four leaves none open
 * coming out, so the Cmd+S test's own tree-row click still mints a fresh tab
 * rather than a second one beside an existing README.
 */
test('closing a dirty editor pane asks first, and cancelling keeps it', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = visiblePane().getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })
  const tabId = await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')

  await content.locator('.cm-content').click()
  await page.keyboard.type('Z')
  await page.getByTestId(`close-${paneId}`).click()

  await expect(page.getByTestId('confirm-close')).toBeVisible()
  await page.getByTestId('confirm-close-cancel').click()
  // Still open, still dirty, still holding the edit.
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(1)
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toBeAttached()
})

test('confirming the prompt closes it and loses the edit', async () => {
  const tabId = await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')
  await page.getByTestId(`close-${paneId}`).click()
  await page.getByTestId('confirm-close-discard').click()
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
  // The file on disk never had the edit, and still does not.
  expect(await readFile(join(projectCwd, 'README.md'), 'utf8')).not.toContain('Z')
})

test('closing a clean editor pane does not ask', async () => {
  // The control. Without it, a prompt that appeared for every pane would pass
  // both tests above.
  await page.getByTestId('tree-row-README.md').click()
  await expect(visiblePane().getByTestId('editor-content')).toContainText('# demo', {
    timeout: 10_000,
  })
  const tabId = await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')
  await page.getByTestId(`close-${paneId}`).click()
  await expect(page.getByTestId('confirm-close')).toHaveCount(0)
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
})

test('closing a terminal pane does not ask', async () => {
  // The other control, and the one that catches a prompt keyed on the wrong
  // thing: a terminal is never dirty, so it must never be asked about.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const tabId = await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')
  const paneId = tabId!.replace('tab-', '')
  await page.getByTestId(`close-${paneId}`).click()
  await expect(page.getByTestId('confirm-close')).toHaveCount(0)
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
})

/**
 * ⌘S writes the pane's document to disk and clears the dirty dot.
 *
 * `tree-row-README.md` is safe to click here: none of the four pane-close
 * tests above leave a README tab open, whichever one of them ran last.
 */
test('Cmd+S writes the file and clears the dot', async () => {
  await page.getByTestId('tree-row-README.md').click()
  const content = visiblePane().getByTestId('editor-content')
  await expect(content).toContainText('# demo', { timeout: 10_000 })
  const paneId = await tabIdFor('README.md')

  await content.locator('.cm-content').click()
  await page.keyboard.type('X')
  await page.keyboard.press('Meta+s')

  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toHaveCount(0)
  // The assertion this test exists for: what is on DISK, not what is on
  // screen. A save that cleared the dot without writing would pass every
  // visual assertion here.
  await expect
    .poll(async () => readFile(join(projectCwd, 'README.md'), 'utf8'), { timeout: 5_000 })
    .toContain('X')
})

/**
 * A file changed underneath the pane refuses the save, and a reload picks up
 * what is actually there.
 *
 * Reached through the tab the test above left open, not a second click on
 * `tree-row-README.md`: that tab is still open, and a second click on the
 * tree row would mint a duplicate and break `tabIdFor('README.md')`'s
 * strict-mode locator.
 */
test('a file changed underneath the pane refuses the save and offers a reload', async () => {
  const paneId = await tabIdFor('README.md')
  await page.getByTestId(`tab-${paneId}`).click()
  const content = visiblePane().getByTestId('editor-content')
  await content.locator('.cm-content').click()
  await page.keyboard.type('Y')

  // Somebody else, which on this machine is the normal case.
  await writeFile(join(projectCwd, 'README.md'), '# theirs\n')

  await page.keyboard.press('Meta+s')
  await expect(visiblePane().getByTestId('editor-refused')).toBeVisible({ timeout: 10_000 })

  // Refused means refused: their text is still on disk.
  expect(await readFile(join(projectCwd, 'README.md'), 'utf8')).toBe('# theirs\n')

  await visiblePane().getByTestId('editor-reload').click()
  await expect(content).toContainText('# theirs')
  await expect(visiblePane().getByTestId('editor-refused')).toHaveCount(0)

  // Closed rather than left open: the last test in this file finds "the
  // terminal tab" as whichever tab is last in the bar, an assumption laid
  // down before this pair of tests existed. Leaving this one open would put
  // it there instead of the shell tab that test expects.
  await page.getByTestId(`close-${paneId}`).click()
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
})

test('the pane menu on an editor offers colours and nothing else', async () => {
  // The second editor tab, the one whose file was deleted in the fourth test.
  // It is still a pane and still right-clickable; what it is showing does not
  // change what the menu may offer.
  const editorTab = await tabIdFor('app.ts')
  await page.getByTestId(`tab-${editorTab}`).click()
  await expect(visiblePane().getByTestId('editor-missing')).toBeVisible({ timeout: 10_000 })

  await page.getByTestId(`pane-${editorTab}`).click({ button: 'right' })
  const menu = page.getByTestId(`pmenu-${editorTab}`)
  await expect(menu).toBeVisible()

  // What it DOES offer, asserted first so "no restart" cannot pass by the menu
  // having failed to open.
  await expect(menu.locator('[data-testid^="swatch-"]').first()).toBeVisible()
  // And what it must not: no restart, under either of the two spellings the
  // app uses for that button. Note that today no pane's menu offers one, live
  // or dead, so this pins the surface rather than a branch: the restart the
  // app really has is the tab bar's `restart-<id>`, asserted absent above, and
  // the pane overlay's, which `paneGroups` decides and the unit tests cover.
  await expect(menu.getByTestId(`restart-${editorTab}`)).toHaveCount(0)
  await expect(menu.getByTestId(`pane-restart-${editorTab}`)).toHaveCount(0)

  // Close it again so the next test starts on a page with no menu over it.
  await page.getByTestId('tabbar').click()
  await expect(menu).toHaveCount(0)
})

/**
 * ⌘D on an editor pane does nothing, and the spec asks for the opposite.
 *
 * **This test pins a defect, not a design.** The spec
 * (`docs/superpowers/specs/2026-08-04-file-tree-and-editor-design.md:132`) says
 * "⌘D on an editor pane: allowed, and splits it like any other pane". It does
 * not. It is a dead key: nothing appears, nothing is thrown, nothing is
 * painted. Deferred to B2 deliberately, by Paolo's ruling during B1's Task 6,
 * rather than left unnoticed.
 *
 * **Amended 2026-08-05, when CodeMirror landed.** It is a dead key only while
 * the editor does not hold keyboard focus, which is the case this test is in:
 * it clicks the TAB, and `document.activeElement` measured as that button
 * rather than `.cm-content`. Measured with `.cm-content` focused instead, ⌘D
 * selects the word under the cursor and `window.getSelection()` goes from
 * empty to that word, because `@codemirror/search`'s `searchKeymap` binds
 * `Mod-d` to `selectNextOccurrence` with `preventDefault: true`. So whoever
 * implements the split inherits a third thing to settle alongside the two
 * below: the editor swallows the chord whenever the user is typing in it.
 *
 * **Two blockers, measured, not one:**
 *
 * 1. Renderer. `App.tsx`'s `splitActive` opens with `paneGrid(activePaneId)`
 *    and returns when it is null. It is null for an editor pane, because
 *    `paneGrid` reads `Terminal.tsx`'s `mounted` map of live xterms and an
 *    editor pane mounts a `FileView` instead. So the split is abandoned in the
 *    renderer and main is never asked.
 * 2. Main, which fails next when the renderer stops returning early. Measured,
 *    not read: with `paneGrid` sabotaged to answer `{cols: 80, rows: 24}` for
 *    an unmounted pane, so the renderer proceeds to IPC, this test failed at
 *    the `startup-error` assertion below with the app painting
 *
 *        Error invoking remote method 'pterm:splitPane':
 *        Error: splitTab: no pane 4faff38fe9376b03
 *
 *    which is `manager.splitTab`'s opening `this.entries.get(input.paneId)`.
 *    Note the shape: the same raw-IPC-error-into-the-UI that closing an editor
 *    tab produced before this task fixed it. Past that throw it would fail
 *    again anyway, because `splitTab` derives the tmux group to join from the
 *    sibling's own session (`groupNameOf`) and an editor tab has none: a pane
 *    added there has to FOUND the tab's group rather than join it.
 *
 * So this is not a skip-site like the four above. It is "add a terminal pane to
 * a tab with no tmux group", and it needs a shared-type decision as well:
 * `SplitRequest` refuses `cols`/`rows` below 1, and an editor pane has no cell
 * grid to halve. That guard exists because this repo has shipped the 80x24
 * geometry defect twice, and relaxing it is not a thing to do in the corner of
 * a sweep. The route sketched for whoever picks it up is in
 * `.superpowers/sdd/2026-08-04-sessionless-panes-b1/task-6-report.md`.
 *
 * **When this test goes red, that is the good outcome.** It means someone
 * implemented the split. Replace it with the positive assertion the spec asks
 * for (pane count in the tab goes up, one new tmux session) rather than
 * repairing it.
 */
test('⌘D on an editor pane does nothing, which is deferred rather than intended', async () => {
  const editorTab = await tabIdFor('app.ts')
  await page.getByTestId(`tab-${editorTab}`).click()

  // `:scope >` inside the visible group, and never a bare
  // `[data-testid^="pane-"]`: that prefix also matches `pane-divider` and the
  // dead-pane chrome, and an unscoped count would be satisfied by a second TAB
  // as readily as by a split. `splits.spec.ts` explains this at length.
  const panes = visiblePane().locator(':scope > [data-testid^="pane-"]')
  await expect(panes).toHaveCount(1)
  const sessionsBefore = await sessionNames(SOCKET)

  await page.keyboard.press('Meta+d')

  // Waited out rather than re-read at once, which is the whole difficulty of
  // asserting an absence. A split that DID work costs a tmux round trip to
  // appear (`splits.spec.ts` polls up to 20s for its session), so an immediate
  // re-read would pass over a split that was merely slow. `waitForTimeout` is
  // the right tool exactly here and is used the same way in `filetree.spec.ts`
  // and `skills.spec.ts`.
  await page.waitForTimeout(3000)

  await expect(panes).toHaveCount(1)
  // The stronger half. A pane box could fail to appear for a rendering reason
  // while main had happily made a session; comparing the whole set says no
  // tmux work happened at all.
  expect(await sessionNames(SOCKET)).toEqual(sessionsBefore)
  // And silently. `splitActive` returns before any IPC, so unlike the close
  // defect this one paints nothing, which is what made it worth a test rather
  // than a bug report.
  await expect(page.getByTestId('startup-error')).toHaveCount(0)
})

/**
 * Two editor panes open on the SAME file, in two different tabs. The mtime
 * check exists for exactly this case, and this is where it is caught doing
 * its job inside one running app rather than only against an outside writer.
 *
 * A file of its own (`dual.txt`), written and cleaned up by this test alone,
 * so it cannot collide with any fixture another test in this file depends on.
 * Both tabs it opens are closed before the test ends, so the tab count and
 * the `.last()` tab assumptions later tests make are undisturbed.
 *
 * Opened by two clicks on the same tree row, which is the only way to get
 * two tabs of one file: `openEditor` mints a fresh pane per call with no
 * dedup by path (see the note above `tabIdFor`), so nothing stops it.
 */
test('two editor panes on one file: a save from one refuses the other, and neither silently shows stale text', async () => {
  const dualFile = join(projectCwd, 'dual.txt')
  await writeFile(dualFile, 'original\n')
  await page.getByTestId('tree-refresh').click()

  // Waited for by count, not read off `.last()` straight after the click:
  // `openEditor` is an IPC round trip, and reading `.last()` before the new
  // tab has actually rendered grabs whichever tab was last BEFORE the click,
  // one of the terminal tabs earlier tests in this file leave open.
  const beforeA = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('tree-row-dual.txt').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(beforeA + 1)
  const paneA = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  await expect(visiblePane().getByTestId('editor-content')).toContainText('original', {
    timeout: 10_000,
  })

  const beforeB = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('tree-row-dual.txt').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(beforeB + 1)
  const paneB = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  expect(paneB).not.toBe(paneA)
  await expect(visiblePane().getByTestId('editor-content')).toContainText('original', {
    timeout: 10_000,
  })

  // Edit and save from A.
  await page.getByTestId(`tab-${paneA}`).click()
  const contentA = visiblePane().getByTestId('editor-content')
  await contentA.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nfrom A')
  await page.keyboard.press('Meta+s')
  await expect(page.getByTestId(`editor-dirty-${paneA}`)).toHaveCount(0)
  await expect.poll(() => readFile(dualFile, 'utf8'), { timeout: 5_000 }).toContain('from A')

  // B, not silently refreshed: it is still showing what it read at open,
  // which predates A's write.
  await page.getByTestId(`tab-${paneB}`).click()
  const contentB = visiblePane().getByTestId('editor-content')
  await expect(contentB).toContainText('original')
  await expect(contentB).not.toContainText('from A')

  // B's own save now refuses: its mtime is the one it opened with, and the
  // file's mtime moved when A wrote it.
  await contentB.locator('.cm-content').click()
  await page.keyboard.type('from B')
  await page.keyboard.press('Meta+s')
  await expect(visiblePane().getByTestId('editor-refused')).toBeVisible({ timeout: 10_000 })
  expect(await readFile(dualFile, 'utf8')).not.toContain('from B')

  // Both tabs closed, so nothing this test opened is left for a later test's
  // `.last()` tab to trip over. B is still dirty (the refused save did not
  // clear it), so its close asks first; A saved clean, so its close does not.
  await page.getByTestId(`close-${paneB}`).click()
  await expect(page.getByTestId('confirm-close')).toBeVisible()
  await page.getByTestId('confirm-close-discard').click()
  await expect(page.getByTestId(`tab-${paneB}`)).toHaveCount(0)

  await page.getByTestId(`tab-${paneA}`).click()
  await page.getByTestId(`close-${paneA}`).click()
  await expect(page.getByTestId(`tab-${paneA}`)).toHaveCount(0)
})

/**
 * A keystroke that lands while a save is in flight, and the dot afterwards.
 *
 * `save` snapshots the document, then awaits an IPC round trip, a disk write
 * and a `stat`. Nothing blocks input during that await, so a character typed
 * inside it is in the document and on no disk. Concluding "clean" from the
 * fact of having written is what made that lossy: the dot went out, and
 * `requestClosePane` then took its no-prompt branch and destroyed the
 * character without asking. Type, ⌘S, type one more, stop, close.
 *
 * **The race is placed rather than raced for**, and that is the only reason
 * this test is worth anything. The ⌘S and the keystroke go out in ONE
 * `page.evaluate`, which is one synchronous task in the renderer:
 * `saveEditorPane` runs inside `dispatchEvent`, so the snapshot is taken and
 * the IPC is in flight before that call returns, and the `execCommand` on the
 * next line cannot be beaten by a reply that needs a later task to arrive.
 * The keystroke lands inside the await every run, with no timing to tune.
 *
 * Two things this trades away, both deliberately. The ⌘S is a synthetic
 * `keydown` on `window`, where `Cmd+S writes the file and clears the dot`
 * above presses the real key through the same handler, so the real route is
 * covered and this one is not asserting it. And `execCommand('insertText')`
 * is how the character is typed, which is checked twice rather than assumed:
 * its return value, and `toContainText('savedz')` on the pane. An insert that
 * quietly did nothing reds there rather than leaving a clean pane to agree
 * with a broken one.
 *
 * **The settle is a `waitForTimeout` and it cannot be anything better.** What
 * has to be waited out is the save's own continuation, which paints nothing
 * of its own: with the defect present the dot goes out only when it runs, so
 * an assertion made a moment too early passes against the bug. Nothing else
 * in the pane moves at that instant: `setRefused(null)` is invisible and the
 * new `mtime` is only observable through another save, which would clear the
 * dot itself and destroy the thing being measured. Holding the write open from
 * the page, which would have given an exact marker, was tried and is not
 * available: measured 2026-08-05, `contextBridge` hands the renderer a frozen
 * object, `window.pterm` is `writable: false, configurable: false` and so is
 * `fsWrite` on it, and both a plain assignment and `defineProperty` are refused
 * (the assignment silently). The continuation is triggered by the same IPC
 * reply the disk write precedes, so once the bytes below are on disk it is one
 * message-loop hop away; two seconds is the same kind of margin the ⌘D test
 * above waits out for the same kind of reason.
 *
 * **Mutation measured 2026-08-05**: `FileView.tsx`'s `onDirtyChange(paneId,
 * current.state.doc.toString() !== baseline.current)` put back to
 * `onDirtyChange(paneId, false)`, the line this test exists for. Reverted
 * after measuring; the result is recorded at the assertion it failed on.
 */
test('a keystroke typed while a save is in flight leaves the pane dirty, and closing it still asks', async () => {
  const raceFile = join(projectCwd, 'race.txt')
  await writeFile(raceFile, 'original\n')
  await page.getByTestId('tree-refresh').click()

  // By count and not off `.last()` straight after the click, for the reason
  // the test above spells out.
  const before = await page.locator('[data-testid^="tab-"]').count()
  await page.getByTestId('tree-row-race.txt').click()
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(before + 1)
  const paneId = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  const content = visiblePane().getByTestId('editor-content')
  await expect(content).toContainText('original', { timeout: 10_000 })

  await content.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nsaved')
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toBeAttached()

  // The whole race, in one task. `code: 'KeyS'` because the handler reads
  // `event.code`, and on `window` because that is where it is registered and
  // because a target that is not an Element passes its `data-shortcuts` guard.
  const typed = await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyS', metaKey: true, bubbles: true, cancelable: true }),
    )
    return document.execCommand('insertText', false, 'z')
  })
  expect(typed).toBe(true)

  // The two halves of the race, each read where it landed: the character is in
  // the document, and the bytes on disk are the snapshot from before it.
  await expect(content).toContainText('savedz', { timeout: 10_000 })
  await expect.poll(() => readFile(raceFile, 'utf8'), { timeout: 10_000 }).toContain('saved')
  expect(await readFile(raceFile, 'utf8')).not.toContain('savedz')

  await page.waitForTimeout(2000)

  // **Mutation measured 2026-08-05**, with `onDirtyChange(paneId, false)` put
  // back: FAILED here with
  //
  //     expect(locator).toBeAttached() failed
  //     Locator: getByTestId('editor-dirty-2c94a2074efc0d3e')
  //     Error: element(s) not found
  //
  // which is the dot going out over a document holding a character that is on
  // no disk.
  await expect(page.getByTestId(`editor-dirty-${paneId}`)).toBeAttached()

  // And what the dot is FOR. With the same mutation still in and the assertion
  // above commented out to see the rest of the path, this FAILED too, with
  // `expect(locator).toBeVisible() failed / Locator: getByTestId('confirm-close')
  // / Error: element(s) not found`: the tab closed with no prompt at all, which
  // is the data loss itself rather than a signal of it.
  await page.getByTestId(`close-${paneId}`).click()
  await expect(page.getByTestId('confirm-close')).toBeVisible()
  await page.getByTestId('confirm-close-discard').click()
  await expect(page.getByTestId(`tab-${paneId}`)).toHaveCount(0)
})

/**
 * The move affordance is withheld from a sessionless tab.
 *
 * Not one of the spec's seven. Found by sweeping for the mechanical signature
 * of the class the seven are drawn from (a call into `SessionManager` for a
 * pane id it may not hold), and it is the same defect as closing was:
 * `manager.moveTabToProject` throws `moveTabToProject: no session for tab
 * <id>` from `panesOfTab` coming back empty, and `fail` paints that string
 * into `startup-error`.
 *
 * Reachable only down this path, which is why it is the last test in the file:
 * the select renders under `synthetic` alone, so a project has to be REMOVED
 * before any tab of it can be moved, and removing it is destructive to every
 * test after this one.
 *
 * See `Sidebar.tsx` for why the affordance is withheld rather than the move
 * implemented: an editor pane's `filePath` is absolute inside the project it
 * came from, so a move that succeeded would leave the pane saying its file was
 * gone.
 */
test('an editor tab under Unsorted is not offered a move, where a terminal is', async () => {
  const editorTab = await tabIdFor('app.ts')
  const terminalTab = (
    (await page.locator('[data-testid^="tab-"]').last().getAttribute('data-testid')) ?? ''
  ).replace('tab-', '')
  expect(terminalTab).not.toBe(editorTab)

  // Removing the project is what sends every one of its panes to Unsorted.
  // The sessions keep running; this only forgets the project row.
  await page.getByTestId('pmenu-p1').click()
  await page.getByTestId('premove-p1').click()

  // Unsorted has to be the selected project before it lists its tabs at all:
  // `Sidebar` renders the tab rows only for the `active` project.
  await page.getByTestId(`project-${UNSORTED_ID}`).click({ timeout: 10_000 })

  // The control, asserted first. A terminal pane under Unsorted still gets its
  // select, so an absence below is about the editor rather than about the
  // whole affordance having gone.
  await expect(page.getByTestId(`smove-${terminalTab}`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`smove-${editorTab}`)).toHaveCount(0)
  // And it is still listed, so it is reachable and simply not movable.
  await expect(page.getByTestId(`stab-${editorTab}`)).toBeVisible()
})
