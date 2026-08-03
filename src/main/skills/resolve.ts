import { join } from 'node:path'

/**
 * Where an entry came from. Moved to `src/shared/ipc.ts` in Task 3, once the
 * renderer needs to draw it; defined here first so this module and its tests
 * stand alone.
 */
export type SkillOrigin = { kind: 'user' } | { kind: 'repo' } | { kind: 'plugin'; plugin: string }

export interface SkillSource {
  dir: string
  source: SkillOrigin
}

interface Install {
  scope: string
  projectPath?: string
  installPath: string
}

/**
 * The `skills/` directories the enabled plugins contribute to one project.
 *
 * Pure: it is handed the two parsed files rather than reading them, for the
 * same reason `notify/rules.ts` is handed its own clock — every rule that can
 * be wrong is then testable with no disk.
 *
 * Stale cached versions and the `.cursor/skills` and `.windsurf/skills`
 * directories that other tools leave under `plugins/marketplaces/` are
 * excluded **by construction**: this only ever builds a path from an
 * `installPath` the registry names, and none of those is one. There is
 * deliberately no filter for them.
 */
export function pluginSkillDirs(
  enabled: unknown,
  registry: unknown,
  projectCwd: string,
): SkillSource[] {
  const flags = asRecord(enabled)
  const plugins = asRecord(asRecord(registry).plugins)
  const dirs: SkillSource[] = []

  for (const [key, value] of Object.entries(flags)) {
    // `=== true`, not truthiness and not key-presence: this map carries
    // explicit `false` entries for plugins the user has turned off, and a
    // presence check would enable every one of them.
    if (value !== true) continue
    const installs = plugins[key]
    if (!Array.isArray(installs)) continue
    const install = pick(installs, projectCwd)
    if (!install) continue
    dirs.push({
      dir: join(install.installPath, 'skills'),
      source: { kind: 'plugin', plugin: key.split('@')[0] ?? key },
    })
  }
  return dirs
}

/**
 * A project-scoped install for exactly this project beats the user-scoped one;
 * with neither, the plugin contributes nothing.
 *
 * Only two plugins on the target machine have more than one install, so this
 * rule is narrow — but it is the difference between showing a project the
 * skills Claude is actually running in it and showing it a different version's.
 */
function pick(installs: unknown[], projectCwd: string): Install | null {
  const valid = installs.filter(isInstall)
  const scoped = valid.find(
    (install) => install.scope === 'project' && install.projectPath === projectCwd,
  )
  if (scoped) return scoped
  return valid.find((install) => install.scope === 'user') ?? null
}

function isInstall(value: unknown): value is Install {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { scope?: unknown; installPath?: unknown }
  return typeof candidate.scope === 'string' && typeof candidate.installPath === 'string'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
