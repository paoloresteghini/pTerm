import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  process.env.PRCLI_CLAUDE_HOME = home
  process.env.PRCLI_CLAUDE_SETTINGS = join(home, 'settings.json')
})

afterEach(async () => {
  process.env.PRCLI_CLAUDE_HOME = saved.home
  process.env.PRCLI_CLAUDE_SETTINGS = saved.settings
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
    expect(names).toContain('brainstorming')
  })

  it('tags each entry with where it came from', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const of = (name: string) => entries.find((entry) => entry.name === name)
    expect(of('browse')?.source).toEqual({ kind: 'user' })
    expect(of('ship')?.source).toEqual({ kind: 'repo' })
    expect(of('brainstorming')?.source).toEqual({ kind: 'plugin', plugin: 'superpowers' })
  })

  it('distinguishes a skill from a command', async () => {
    const entries = await listSkills(project)
    expect(entries.length).toBeGreaterThan(0)
    const of = (name: string) => entries.find((entry) => entry.name === name)
    expect(of('browse')?.kind).toBe('skill')
    expect(of('gsd:stats')?.kind).toBe('command')
  })

  it('falls back to the filename when a file declares no name', async () => {
    const entries = await listSkills(project)
    expect(entries.map((entry) => entry.name)).toContain('reapply-patches')
  })

  it('falls back to the filename when a file declares an empty name', async () => {
    // A different case from the one above, and the only one that pins the
    // `||`. With `name:` ABSENT, `frontmatter` returns no `name` key at all,
    // so `fields.name` is `undefined` with or without the guard — which is
    // why the missing-name test cannot catch its removal. With `name:`
    // PRESENT and empty, `frontmatter` returns `name: ''`, `??` would keep
    // the empty string, and the panel would draw a blank, unclickable row.
    //
    // No file on this machine has this today (0 of 109). It is kept because
    // two reachable shapes produce it — `name: ""`, and a `name: >` fold with
    // no body — and because a blank row is a worse failure than a wrong one.
    await write(join(home, 'commands', 'gsd', 'blank-name.md'), '---\nname:\ndescription: Blank.\n---\n')
    const entries = await listSkills(project)
    expect(entries.map((entry) => entry.name)).toContain('blank-name')
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
    expect(entries.map((entry) => entry.name)).toContain('brainstorming')
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
