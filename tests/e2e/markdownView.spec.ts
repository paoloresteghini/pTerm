/**
 * The rendered markdown pane: what a `.md` file looks like when it opens, and
 * what the toggle beside it does.
 *
 * **A file of its own rather than more tests in `editor.spec.ts`, and the
 * reason is not scope.** Every test in that file reaches its pane through the
 * tab bar, and `App.tsx` currently renders that bar behind a literal `false`
 * (`{false && !wallOn ? <TabBar .../> : null}`, from `cf87ca2 Use sidebar for
 * split tab navigation`), so `tabbar`, `tab-<id>`, `close-<id>` and
 * `editor-dirty-<id>` are on no page. `editor.spec.ts` fails at its first
 * assertion for that reason, before this feature existed and independently of
 * it. Nothing here touches any of those ids: panes are opened from the file
 * tree and read through `terminal-active`, which is the same surface with or
 * without a bar above it.
 *
 * One app and one `page` for the file, like `editor.spec.ts`: the tests are a
 * sequence, and the third depends on what the second typed.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-markdown'

/**
 * The document every test here reads.
 *
 * Every line is load-bearing. The heading is what a rendered view must turn
 * into an `<h1>`; the two links are the allowed and the refused case for
 * `externalHref`; the table is GFM, which CommonMark alone leaves as four
 * lines of pipes and which is the whole reason `remark-gfm` is a dependency;
 * and the last line is raw HTML carrying an `onerror`, which is the one
 * assertion in this file about safety rather than appearance.
 */
const GUIDE_BYTES = [
  '# Guide',
  '',
  'A [site](https://example.com/docs) and a [neighbour](./other.md).',
  '',
  '| Decision | Why |',
  '| --- | --- |',
  '| Render markdown | Syntax is not the document |',
  '',
  '<img src="x" onerror="window.PWNED = 1">',
  '',
].join('\n')

/** Seeded as `notes.txt`: the control for "only markdown gets a toggle". */
const PLAIN_BYTES = 'export const answer = 42\n'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let projectCwd: string
let externalLog: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-md-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-md-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-md-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-md-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-md-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  // Where `openExternal` writes instead of handing a URL to the real browser.
  // Without it a click on the seeded link opens a tab on the machine running
  // the suite, which is a thing this repo has done to a developer before.
  externalLog = join(claudeHome, 'external.log')

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })
  await writeFile(join(projectCwd, 'guide.md'), GUIDE_BYTES)
  await writeFile(join(projectCwd, 'notes.txt'), PLAIN_BYTES)

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 8,
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: null },
      ],
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
    externalLog,
  })
  page = await app.firstWindow()
  await expandColumn(page, 'files')
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

// Scoped to the visible group rather than the page: every pane in the
// workspace stays mounted whatever is on screen, so an unscoped
// `getByTestId('editor-content')` matches one element per open editor.
const visiblePane = (): ReturnType<Page['getByTestId']> => page.getByTestId('terminal-active')

/**
 * A markdown file opens rendered, and raw HTML inside it stays text.
 *
 * The `window.PWNED` assertion is the one worth the seeded fixture. These are
 * files out of a project directory, which for a cloned repository is text a
 * stranger wrote, and this renders it inside the process holding
 * `window.pterm`. `MarkdownDoc` claims nothing in its path can turn a string
 * into markup, because `react-markdown` builds React elements and `rehype-raw`
 * is deliberately not installed. This measures that claim rather than
 * restating it: the `onerror` never runs and the tag is on screen as the
 * characters the author typed.
 *
 * Both halves are needed. The `PWNED` check alone would pass if the tag had
 * been silently dropped, which is a different behaviour with a different
 * failure mode; the text check alone would pass if it had been rendered AND
 * escaped somewhere downstream.
 */
test('a markdown file opens rendered, and raw html in it stays text', async () => {
  await page.getByTestId('tree-row-guide.md').click({ timeout: 20_000 })
  const doc = visiblePane().getByTestId('markdown-doc')
  await expect(doc.locator('h1')).toHaveText('Guide', { timeout: 20_000 })

  // The source is not merely behind the rendering, it is not on screen.
  await expect(visiblePane().getByTestId('editor-content')).toBeHidden()

  // GFM, which CommonMark alone leaves as pipes and dashes.
  await expect(doc.locator('table th').first()).toHaveText('Decision')
  await expect(doc.locator('table td').first()).toHaveText('Render markdown')

  await expect(doc).toContainText('<img src="x" onerror="window.PWNED = 1">')
  expect(await page.evaluate(() => (window as unknown as { PWNED?: number }).PWNED)).toBe(undefined)
  // The tag reached the document as text and not as an element: the same fact
  // from the other side, and the one that would still be false if some later
  // change escaped the string only for display.
  await expect(doc.locator('img')).toHaveCount(0)
})

/**
 * An http link is handed to the system opener; a relative one is inert.
 *
 * Read off `PTERM_EXTERNAL_LOG` rather than off the screen, because that is
 * the only place the outcome exists: `shell.openExternal` cannot be stubbed
 * from a spec (`contextBridge` hands the renderer a frozen object), so main
 * diverts the URL to this file when the variable is set.
 *
 * The relative half is asserted by the log NOT growing, which is only
 * meaningful because the line above it proves the log is written at all. On
 * its own, "nothing was appended" is also what a broken harness looks like.
 *
 * **What that half does NOT pin, measured by sabotage 2026-09-08.** With
 * `externalHref` rewritten to return every href unchanged, this test stayed
 * green: main's `isOpenable` refuses `./other.md` at the handler and the log
 * never grows either way. So this asserts that the PAIR holds, not that the
 * renderer's own allow-list does. What pins that one is
 * `tests/unit/markdownLinks.test.ts`, where the same sabotage fails three
 * assertions. The last line here is the part that is this file's to hold:
 * with `preventDefault` removed from `MarkdownDoc`'s anchor, this test and the
 * one after it both failed, because the click took the renderer to the
 * document and there was no app left to assert on.
 */
test('an http link opens externally and a relative one does nothing', async () => {
  const doc = visiblePane().getByTestId('markdown-doc')
  await doc.getByText('site', { exact: true }).click()
  await expect
    .poll(() => readFile(externalLog, 'utf8').catch(() => ''), { timeout: 10_000 })
    .toContain('https://example.com/docs')

  const after = await readFile(externalLog, 'utf8')
  await doc.getByText('neighbour', { exact: true }).click()
  await page.waitForTimeout(500)
  expect(await readFile(externalLog, 'utf8')).toBe(after)
  // And the click did not navigate the renderer away from the app, which is
  // what an anchor left to act on its own href would have done.
  await expect(visiblePane().getByTestId('markdown-doc')).toBeVisible()
})

/**
 * The toggle reaches the source, and preview then renders what is not saved.
 *
 * The second half is what the arrangement inside `FileView` exists for. The
 * `EditorView` is kept mounted behind the rendered view rather than unmounted,
 * so a flip to preview and back cannot discard typing. The disk read at the
 * end is the proof that what preview painted had been written nowhere.
 */
test('the toggle shows the source, and preview renders unsaved edits', async () => {
  await visiblePane().getByTestId('md-toggle').click()
  const content = visiblePane().getByTestId('editor-content')
  // The `#` is back, which is the difference between the two halves stated as
  // an assertion rather than as a mode name.
  await expect(content).toContainText('# Guide', { timeout: 10_000 })
  await expect(visiblePane().getByTestId('markdown-doc')).toHaveCount(0)

  // `.cm-content` clicked directly: the keystroke needs the editable element
  // to land on, and this project has had `toBeVisible` pass on an element
  // painted behind the terminal, so the click is the assertion.
  await content.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n\nZephyr')
  await expect(content).toContainText('Zephyr')

  await visiblePane().getByTestId('md-toggle').click()
  await expect(visiblePane().getByTestId('markdown-doc')).toContainText('Zephyr')
  // Nothing was written on the way. Preview is a view of the document, not a
  // save.
  expect(await readFile(join(projectCwd, 'guide.md'), 'utf8')).not.toContain('Zephyr')

  // And back once more, to the same document rather than to a rebuilt one: a
  // view that had been destroyed on the way into preview would come back
  // holding what was read from disk, with `Zephyr` gone and no error anywhere.
  await visiblePane().getByTestId('md-toggle').click()
  await expect(visiblePane().getByTestId('editor-content')).toContainText('Zephyr')
})

/**
 * A file no grammar calls markdown gets no toggle and no rendering.
 *
 * The control. Without it, a toggle that appeared on every editor pane would
 * pass every test above.
 */
test('a plain file has no toggle and opens as source', async () => {
  await page.getByTestId('tree-row-notes.txt').click()
  await expect(visiblePane().getByTestId('editor-content')).toContainText(
    'export const answer = 42',
    { timeout: 20_000 },
  )
  await expect(visiblePane().getByTestId('md-toggle')).toHaveCount(0)
  await expect(visiblePane().getByTestId('markdown-doc')).toHaveCount(0)
})
