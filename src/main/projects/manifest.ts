import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Preset } from '../state/store'

export interface ResolvedPreset extends Preset {
  /** Where this came from, so the panel can show which the repo supplied. */
  origin: 'user' | 'repo'
}

const MANIFEST = '.prcli.json'

function isPresetLike(value: unknown): value is { label: string; command: string } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { label?: unknown; command?: unknown }
  return typeof candidate.label === 'string' && typeof candidate.command === 'string'
}

/**
 * Presets a repository declares for itself.
 *
 * Never throws, for the same reason `ConfigStore.read` never does: a damaged
 * file in one of five customers' repositories must not stop the app starting.
 * A missing, unreadable or malformed manifest simply contributes nothing.
 *
 * Read on every restore rather than cached at add time, so a repo's commands
 * track the repo.
 */
export async function readManifest(cwd: string): Promise<Preset[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(cwd, MANIFEST), 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const presets = (parsed as { presets?: unknown }).presets
  if (!Array.isArray(presets)) return []
  return presets.filter(isPresetLike).map((preset) => ({
    // The file carries no id. This one only has to be stable within a render
    // and unique among the project's presets — nothing persists it.
    id: `repo:${preset.label}`,
    label: preset.label,
    command: preset.command,
  }))
}

/** User presets win on label, and sort first. */
export function mergePresets(user: Preset[], repo: Preset[]): ResolvedPreset[] {
  const overridden = new Set(user.map((preset) => preset.label))
  return [
    ...user.map((preset): ResolvedPreset => ({ ...preset, origin: 'user' })),
    ...repo
      .filter((preset) => !overridden.has(preset.label))
      .map((preset): ResolvedPreset => ({ ...preset, origin: 'repo' })),
  ]
}
