import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { SkillEntry, SkillOrigin } from '../../shared/ipc'
import { claudeSettingsPath } from '../hooks/install'
import { frontmatter } from './frontmatter'
import { pluginRoots, type PluginRoot } from './resolve'

/**
 * The directory holding skills, commands and the plugin registry.
 *
 * `settings.json` is deliberately NOT resolved from here — it comes from
 * `claudeSettingsPath()`, so the app has exactly one answer for where that
 * file is. Two overrides naming one file is how they drift apart.
 *
 * Both are required overrides in tests: `tests/integration/skills.test.ts`
 * sets them directly, and `tests/e2e/harness.ts` takes `claudeHome` as a
 * required launch option, asserts it sits under the temp root before any
 * spawn, and passes it as `PRCLI_CLAUDE_HOME`. `e2eSafety.test.ts`'s
 * `GUARDED_VARS` enumerates it, so a launch site that drops it fails the
 * guard rather than silently reading the developer's real `~/.claude`.
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

  const roots: PluginRoot[] = pluginRoots(enabled?.enabledPlugins, registry, projectCwd)

  const entries: SkillEntry[] = []
  entries.push(...(await skillsIn(join(home, 'skills'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(home, 'commands'), { kind: 'user' })))
  entries.push(...(await commandsIn(join(projectCwd, '.claude', 'commands'), { kind: 'repo' })))
  for (const root of roots) {
    entries.push(...(await skillsIn(join(root.base, 'skills'), root.source)))
    entries.push(...(await commandsIn(join(root.base, 'commands'), root.source)))
  }
  return entries
}

/**
 * The string a user would type, derived from where the entry lives.
 *
 * `rel` is the entry's path below the root it was found in: a skill's
 * directory name, or a command's path with `.md` stripped. Separators become
 * `:`, and anything a plugin contributed carries its plugin as a prefix.
 *
 * This is what Claude Code itself offers, measured rather than assumed:
 * `superpowers:brainstorming` rather than bare, `gsd:reapply-patches` for the
 * one command file declaring no name, and the directory name for all three
 * skills whose `name:` disagrees with it.
 */
function entryName(rel: string, source: SkillOrigin): string {
  const local = rel.split(sep).join(':')
  return source.kind === 'plugin' ? `${source.plugin}:${local}` : local
}

/** `<dir>/<name>/SKILL.md`, which is the only layout a skill directory has. */
async function skillsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  for (const name of await listDir(dir)) {
    const description = await readDescription(join(dir, name, 'SKILL.md'))
    if (description === null) continue
    entries.push({ name: entryName(name, source), description, kind: 'skill', source })
  }
  return entries
}

/**
 * Every `.md` under `dir`, at any depth, named after its path below `dir`.
 *
 * Depth matters and is where the name comes from: `commands/gsd/stats.md` is
 * `gsd:stats`. The file's own `name:` is not consulted: it agrees in almost
 * every case, and where it disagrees Claude Code uses the path.
 */
async function commandsIn(dir: string, source: SkillOrigin): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  for (const path of await walk(dir)) {
    if (!path.endsWith('.md')) continue
    const description = await readDescription(path)
    if (description === null) continue
    const rel = relative(dir, path).slice(0, -'.md'.length)
    entries.push({ name: entryName(rel, source), description, kind: 'command', source })
  }
  return entries
}

/** The file's declared description, or null when it cannot be read at all. */
async function readDescription(path: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  return frontmatter(text).description ?? ''
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
