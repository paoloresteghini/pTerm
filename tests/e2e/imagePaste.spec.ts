/**
 * Pasting an image into a terminal pane, and what reaches the pty when you do.
 *
 * The gesture this file exists for is ⌘V with a screenshot on the clipboard.
 * That paste is Chromium's, not xterm's (this app ships `{ role: 'editMenu' }`),
 * and an image has no text flavour, so before `imageOnlyPaste` the keystroke
 * either did nothing at all or sent a bare `ESC[200~ ESC[201~` (an empty
 * bracketed paste) to whatever was running in the pane. What a terminal is
 * supposed to hand over is `Ctrl+V`, which the program reads for itself:
 * measured 2026-08-18, Claude Code answers `0x16` by reading the macOS
 * clipboard through `osascript ... «class PNGf»` and inserting `[Image #1]`.
 *
 * The bytes are read off the PTY rather than out of the terminal's buffer, and
 * that is the only way this question can be asked honestly: a tty in canonical
 * mode treats `0x16` as `lnext` and quotes the next character instead of
 * echoing anything, so a buffer assertion passes identically whether the byte
 * arrived or not (measured: that was the first probe, and it proved nothing).
 * `stty raw -echo` plus `head -c` takes the bytes exactly as the pty received
 * them, and the trailing `END` is what makes the count exact: an extra byte
 * before it, such as a stray bracketed-paste marker, shifts the expected hex.
 *
 * Sabotage check results, measured 2026-08-18:
 * - handler returns early for every paste: "an image with no text sends Ctrl+V
 *   to the program" reddens, `16 45 4e 44` becoming nothing at all.
 * - `stopPropagation` removed: the same test reddens with `16 1b 5b 32`, the
 *   `0x16` followed by xterm's empty bracketed paste. That mutation SURVIVED
 *   until `capturePty` turned bracketed mode on, which is why it does.
 *
 * The paste is SYNTHETIC. Playwright cannot put a file on the system clipboard
 * and press ⌘V, so a `ClipboardEvent` carrying a `DataTransfer` is dispatched
 * at the textarea xterm listens on. What that does exercise is the part this
 * change owns: the capture-phase handler, the rule that reads the item types,
 * and the byte it writes. What it does not exercise is Chromium's own
 * clipboard-to-DataTransfer step.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-paste'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let page: Page

/**
 * Take the next `count` bytes the pty receives, raw, with bracketed paste on.
 *
 * `-echo` as well as `raw` so the shell's own echo cannot add bytes of its own
 * to the file being asserted on.
 *
 * `ESC[?2004h` is what makes this able to tell the two paste paths apart at
 * all. Bracketed-paste mode is a mode the PROGRAM turns on, and under
 * `stty raw` with `head` in the foreground nothing has: measured, with the mode
 * off, xterm pasting the empty string emits no bytes, so a handler that let the
 * event reach xterm passed the assertion identically to one that took it.
 * Claude Code and every shell prompt run with the mode ON, which is the state
 * these tests have to be asked in.
 */
async function capturePty(window: Page, count: number): Promise<string> {
  const out = join(projectCwd, `pty-${count}.bin`)
  await window.keyboard.type(`printf '\\033[?2004h'; stty raw -echo; head -c ${count} > ${out}; stty sane`)
  await window.keyboard.press('Enter')
  // The shell has to have reached `head` before anything is sent at it, and
  // there is nothing on screen to wait for: `-echo` is already in force.
  await window.waitForTimeout(3000)
  return out
}

/** Dispatch a paste carrying `text` (possibly empty) and an image file. */
async function pasteImage(window: Page, text: string): Promise<void> {
  await window.evaluate((pasted) => {
    const data = new DataTransfer()
    if (pasted !== '') data.setData('text/plain', pasted)
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }))
    const target =
      document.querySelector('.xterm-helper-textarea') ??
      document.querySelector('[data-testid="terminal"]')
    target?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

const hexOf = (bytes: Buffer): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-pv-ud-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-pv-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-pv-proj-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-pv-cwd-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-pv-cs-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, '{}', 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-pv-home-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 10,
      projects: [
        { id: 'id-p', name: 'P', slug: 'p', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-p',
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
  page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible({ timeout: 30_000 })
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/*
 * `0x16` and nothing else. The three-byte tail is what says "nothing else":
 * the four bytes read are the whole of what the pty got, so an empty bracketed
 * paste ahead of them would push `END` out of the window and change the hex.
 */
test('an image with no text sends Ctrl+V to the program', async () => {
  test.setTimeout(120_000)
  const out = await capturePty(page, 4)

  await pasteImage(page, '')
  await page.keyboard.type('END')

  await expect
    .poll(async () => hexOf(await readFile(out).catch(() => Buffer.alloc(0))), { timeout: 20_000 })
    .toBe('16 45 4e 44')
})

/*
 * A clipboard carrying both flavours is xterm's to handle, and it handles it
 * better than this could: bracketed-paste markers, CR translation, the lot.
 * The expected bytes are `ESC[200~hi ESC[201~END`, so this asserts both halves
 * at once: that no `0x16` went in front, and that the text still arrives
 * WRAPPED, which is the property a handler that pasted text itself would lose.
 */
test('an image alongside text leaves xterm to paste the text', async () => {
  test.setTimeout(120_000)
  const out = await capturePty(page, 17)

  await pasteImage(page, 'hi')
  await page.keyboard.type('END')

  await expect
    .poll(async () => hexOf(await readFile(out).catch(() => Buffer.alloc(0))), { timeout: 20_000 })
    .toBe('1b 5b 32 30 30 7e 68 69 1b 5b 32 30 31 7e 45 4e 44')
})

/*
 * The keystroke a native terminal sends, sent by hand. This is the byte the
 * image paste above impersonates, and it is asserted here so that a regression
 * in xterm's own key handling cannot be mistaken for a regression in the paste
 * handler.
 */
test('Ctrl+V typed by hand still reaches the pty', async () => {
  test.setTimeout(120_000)
  const out = await capturePty(page, 4)

  await page.keyboard.press('Control+v')
  await page.keyboard.type('END')

  await expect
    .poll(async () => hexOf(await readFile(out).catch(() => Buffer.alloc(0))), { timeout: 20_000 })
    .toBe('16 45 4e 44')
})
