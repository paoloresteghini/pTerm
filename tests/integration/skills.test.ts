import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills } from '../../src/main/skills/scan'

const saved = {
  home: process.env.PRCLI_CLAUDE_HOME,
  settings: process.env.PRCLI_CLAUDE_SETTINGS,
}

let root = ''
let home = ''
let project = ''

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prcli-skills-'))
  home = join(root, 'claude')
  project = join(root, 'project')

  await write(join(home, 'skills', 'browse', 'SKILL.md'), '---\nname: browse\ndescription: Fast browser.\n---\n')
  await write(join(home, 'commands', 'gsd', 'stats.md'), '---\nname: gsd:stats\ndescription: Show stats.\n---\n')
  // The one real command file with no `name:` — the fallback's case.
  await write(join(home, 'commands', 'gsd', 'reapply-patches.md'), '---\ndescription: Reapply.\n---\n')
  await write(join(project, '.claude', 'commands', 'ship.md'), '---\nname: ship\ndescription: Ship it.\n---\n')

  const install = join(root, 'cache', 'superpowers')
  await write(join(install, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: Shape ideas.\n---\n')
  // An enabled plugin whose install has no skills/ directory at all — 12 of
  // the 25 real installs are like this.
  const bare = join(root, 'cache', 'bare')
  await mkdir(bare, { recursive: true })

  await write(
    join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@m': [{ scope: 'user', installPath: install }],
        'bare@m': [{ scope: 'user', installPath: bare }],
      },
    }),
  )
  await write(
    join(home, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'superpowers@m': true, 'bare@m': true } }),
  )

  // A plugin shipping BOTH skills and commands. Five enabled plugins on the
  // real machine ship commands, and none of them were scanned before.
  await write(join(install, 'commands', 'ship-it.md'), '---\ndescription: Ship.\n---\n')
  await write(join(install, 'commands', 'nested', 'deep.md'), '---\ndescription: Deep.\n---\n')

  process.env.PRCLI_CLAUDE_HOME = home
  process.env.PRCLI_CLAUDE_SETTINGS = join(home, 'settings.json')
})

afterEach(async () => {
  if (saved.home === undefined) delete process.env.PRCLI_CLAUDE_HOME
  else process.env.PRCLI_CLAUDE_HOME = saved.home
  if (saved.settings === undefined) delete process.env.PRCLI_CLAUDE_SETTINGS
  else process.env.PRCLI_CLAUDE_SETTINGS = saved.settings
  await rm(root, { recursive: true, force: true })
})

describe('listSkills', () => {
  it('finds personal skills, personal commands, repo commands and plugin skills', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('browse')
    expect(names).toContain('gsd:stats')
    expect(names).toContain('ship')
    expect(names).toContain('superpowers:brainstorming')
  })

  it('namespaces a plugin skill with its plugin', async () => {
    // The defect this task exists for: `brainstorming` is not a string anyone
    // can type. `superpowers:brainstorming` is.
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.map((entry) => entry.name)).not.toContain('brainstorming')
  })

  it('scans the commands a plugin ships, at any depth', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('superpowers:ship-it')
    expect(names).toContain('superpowers:nested:deep')
  })

  it('names a command after its path below the root, not its own declaration', async () => {
    // `commands/gsd/stats.md` declares `gsd:stats` and happens to agree. The
    // file with no `name:` at all is what proves the path is the source: it
    // must come back namespaced, not as a bare filename.
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.map((entry) => entry.name)).toContain('gsd:reapply-patches')
  })

  it('ignores a declared name that differs from the directory', async () => {
    // Three skills on the author's machine do this, and Claude Code uses the
    // directory in all three cases.
    await write(
      join(home, 'skills', 'actual-dir', 'SKILL.md'),
      '---\nname: declared-something-else\ndescription: D.\n---\n',
    )
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('actual-dir')
    expect(names).not.toContain('declared-something-else')
  })

  it('tags each entry with where it came from', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const of = (name: string) => entries.find((entry) => entry.name === name)
    expect(of('browse')?.source).toEqual({ kind: 'user' })
    expect(of('ship')?.source).toEqual({ kind: 'repo' })
    expect(of('superpowers:brainstorming')?.source).toEqual({ kind: 'plugin', plugin: 'superpowers' })
  })

  it('distinguishes a skill from a command', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const of = (name: string) => entries.find((entry) => entry.name === name)
    expect(of('browse')?.kind).toBe('skill')
    expect(of('gsd:stats')?.kind).toBe('command')
  })

  it('survives a plugin install with no skills directory', async () => {
    // `bare` is enabled and resolves to a real installPath with no `skills/`
    // inside it — 12 of the 25 real installs are like this. The premise is
    // load-bearing in the only way that matters here: with `listDir`'s catch
    // removed this rejects, and with `bare` removed from the fixture there is
    // no missing directory left to reject on.
    //
    // Note what is deliberately NOT asserted: that no entry carries
    // `plugin: 'bare'`. That would be true with the handling broken, with the
    // handling absent, and with `bare` deleted from the fixture — a control
    // that cancels itself out. Not throwing is the whole observable.
    await expect(listSkills(project)).resolves.toBeInstanceOf(Array)
    const entries = await listSkills(project)
    expect(entries.map((entry) => entry.name)).toContain('superpowers:brainstorming')
  })

  it('returns entries rather than throwing when settings.json is damaged', async () => {
    await writeFile(join(home, 'settings.json'), '{ not json', 'utf8')
    const entries = await listSkills(project)
    // Plugins are lost — nothing said which are enabled — but the personal
    // and repo halves are independent of that file and must survive.
    expect(entries.map((entry) => entry.name)).toContain('browse')
    expect(entries.map((entry) => entry.name)).toContain('ship')
  })

  it('returns an empty list rather than throwing when nothing exists', async () => {
    await rm(home, { recursive: true, force: true })
    await expect(listSkills(join(root, 'nowhere'))).resolves.toEqual([])
  })
})

describe('the skills handler', () => {
  it('is registered on the channel the preload bridge invokes', async () => {
    // `register.ts` needs an Electron `ipcMain` and a real SessionManager to
    // import, neither of which exists under vitest's node environment. What
    // is checkable — and what actually breaks — is that the three sides agree
    // on one channel name and one method name. A grep is a poor test; it is
    // better than the nothing otherwise on offer, and it is the same trade
    // `shortcuts.test.ts` and `appLayout.test.ts` already make here.
    const [shared, main, bridge] = await Promise.all([
      readFile('src/shared/ipc.ts', 'utf8'),
      readFile('src/main/ipc/register.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8'),
    ])
    expect(shared).toContain("skills: 'prcli:skills'")
    expect(shared).toMatch(/skills\(projectCwd: string\): Promise<SkillEntry\[\]>/)
    expect(main).toContain('ipcMain.handle(CHANNELS.skills')
    expect(bridge).toContain('ipcRenderer.invoke(CHANNELS.skills, projectCwd)')
  })
})
