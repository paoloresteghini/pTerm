/**
 * The file index against a real repository and a real plain directory.
 *
 * The whole reason this uses `git ls-files` is `.gitignore`, and that claim can
 * only be checked by making a repo with an ignore file in it and looking at
 * what comes back. The fallback matters too: a project that is not a repo must
 * still list its files rather than answering empty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { projectFiles } from '../../src/main/files/projectFiles'

const run = promisify(execFile)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pterm-files-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(root, 'src', 'app.ts'), '')
  await writeFile(join(root, 'README.md'), '')
  await writeFile(join(root, 'dist', 'bundle.js'), '')
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), '')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeRepo(): Promise<void> {
  await run('git', ['init', '-q'], { cwd: root })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await run('git', ['config', 'user.name', 'Test'], { cwd: root })
  await writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n')
}

describe('projectFiles in a repository', () => {
  it('lists tracked and untracked files', async () => {
    await makeRepo()
    await run('git', ['add', 'src/app.ts'], { cwd: root })
    await run('git', ['commit', '-qm', 'first'], { cwd: root })

    const { files } = await projectFiles(root)
    expect(files).toContain('src/app.ts')
    // Untracked but not ignored. Without `--others` a file made a minute ago
    // would be missing from the palette, which is when it is most looked for.
    expect(files).toContain('README.md')
  })

  /*
   * The claim the whole git route exists for. `dist/` is a real directory with
   * a real file in it, ignored only by `.gitignore` — nothing in this app's own
   * filter would have excluded it.
   */
  it('honours .gitignore', async () => {
    await makeRepo()
    const { files } = await projectFiles(root)
    expect(files).not.toContain('dist/bundle.js')
    expect(files.some((path) => path.startsWith('node_modules/'))).toBe(false)
    // The control: the ignore file did not simply hide everything.
    expect(files).toContain('src/app.ts')
  })

  it('does not report truncation for a small repo', async () => {
    await makeRepo()
    expect((await projectFiles(root)).truncated).toBe(false)
  })
})

describe('projectFiles outside a repository', () => {
  it('falls back to walking, and still finds files', async () => {
    const { files } = await projectFiles(root)
    expect(files).toContain('src/app.ts')
    expect(files).toContain('README.md')
  })

  /*
   * The fallback's filter is the app's own `{.git, node_modules}` and NOT
   * gitignore, so `dist/` is expected here. Asserted rather than left implicit:
   * this is the documented cost of a project that is not a repo, and a future
   * reader should see that it is intended rather than a leak.
   */
  it('applies only the built-in filter, so an ignored build directory appears', async () => {
    const { files } = await projectFiles(root)
    expect(files.some((path) => path.startsWith('node_modules/'))).toBe(false)
    expect(files).toContain('dist/bundle.js')
  })
})
