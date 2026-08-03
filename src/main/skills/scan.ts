import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SkillEntry, SkillOrigin } from '../../shared/ipc'
import { claudeSettingsPath } from '../hooks/install'
import { frontmatter } from './frontmatter'
import { pluginSkillDirs, type SkillSource } from './resolve'

/**
 * The directory holding skills, commands and the plugin registry.
 *
 * `settings.json` is deliberately NOT resolved from here — it comes from
 * `claudeSettingsPath()`, so the app has exactly one answer for where that
 * file is. Two overrides naming one file is how they drift apart.
 *
 * `tests/integration/skills.test.ts` sets both. **`harness.ts` does not yet
 * pass `PRCLI_CLAUDE_HOME`**, so an E2E-launched app still falls back to the
 * real `~/.claude` here — read-only, but it makes assertions depend on
 * whatever happens to be installed that week. Task 5 of this plan adds it as
 * a sixth required launch option and enumerates it in `e2eSafety.test.ts`'s
 * `GUARDED_VARS`; nothing launches the app against this module before then.
 */
export function claudeHome(): string {
  return process.env.PRCLI_CLAUDE_HOME ?? join(homedir(), '.claude')
}

/**
 * Every skill and command available to one project.
 *
 * Never throws, and never writes. A damaged `settings.json`, a registry whose
 * shape changed under a Claude Code update, an unreadable directory or a
 * malformed skill file contributes nothing rather than stopping the panel from
 * opening — the same rule, for the same reason, as `projects/manifest.ts`.
 *
 * Read on every open rather than cached, so a skill written a minute ago is
 * there. The cost is that an already-open panel does not update behind the
 * user's back, which is the accepted trade.
 */
export async function listSkills(projectCwd: string): Promise<SkillEntry[]> {
  const home = claudeHome()
  const enabled = (await readJson(claudeSettingsPath())) as { enabledPlugins?: unknown } | null
  const registry = await readJson(join(home, 'plugins', 'installed_plugins.json'))

  const sources: SkillSource[] = [
    ...pluginSkillDirs(enabled?.enabledPlugins, registry, projectCwd),
  ]

  const entries: SkillEntry[] = []
  entries.push(...(await skillsIn(join(home, 'skills'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(home, 'commands'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(projectCwd, '.claude', 'commands'), { kind: 'repo' })))
  for (const source of sources) {
    entries.push(...(await skillsIn(source.dir, source.source)))
  }
  return entries
}

/** `<dir>/<name>/SKILL.md`, which is the only layout a skill directory has. */
async function skillsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const names = await listDir(dir)
  const entries: SkillEntry[] = []
  for (const name of names) {
    const parsed = await parse(join(dir, name, 'SKILL.md'))
    if (!parsed) continue
    entries.push({
      name: parsed.name ?? name,
      description: parsed.description ?? '',
      kind: 'skill',
      source,
    })
  }
  return entries
}

/**
 * Every `.md` under `dir`, at any depth.
 *
 * Depth matters: the real tree is `commands/gsd/*.md`. The command's own
 * `name:` is already namespaced (`gsd:stats`), so nothing here derives a name
 * from the path — the file says what it is called, and the filename is only
 * the fallback for the one file that does not.
 */
async function commandsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  for (const path of await walk(dir)) {
    if (!path.endsWith('.md')) continue
    const parsed = await parse(path)
    if (!parsed) continue
    entries.push({
      name: parsed.name ?? basename(path, '.md'),
      description: parsed.description ?? '',
      kind: 'command',
      source,
    })
  }
  return entries
}

async function parse(path: string): Promise<{ name?: string; description?: string } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const fields = frontmatter(text)
  return { name: fields.name || undefined, description: fields.description ?? '' }
}

async function walk(dir: string): Promise<string[]> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const item of items) {
    const path = join(dir, item.name)
    if (item.isDirectory()) found.push(...(await walk(path)))
    else found.push(path)
  }
  return found
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    return items.filter((item) => item.isDirectory()).map((item) => item.name)
  } catch {
    return []
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}
