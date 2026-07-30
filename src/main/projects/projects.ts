import { randomBytes } from 'node:crypto'
import { slugify } from '../tmux/names'
import type { PrcliConfig, Preset, ProjectRecord } from '../state/store'

/**
 * The synthetic project that collects tabs whose slug matches nothing real.
 * Reserved so a user-created project can never shadow it.
 */
export const UNSORTED_ID = 'unsorted'

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([UNSORTED_ID])

function newId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * A session-safe slug that no existing project holds.
 *
 * The discriminator separator is `_`, not `-`: slugs must match
 * /^[a-z0-9_]+$/, and `decodeSessionName` splits a name into exactly three
 * dash-separated parts, so a dash inside a slug would break both directions.
 */
export function allocateSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugify(name)
  if (!used.has(base) && !RESERVED_SLUGS.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`
    if (!used.has(candidate) && !RESERVED_SLUGS.has(candidate)) return candidate
  }
}

export function addProject(
  config: PrcliConfig,
  input: { name: string; cwd: string },
): { config: PrcliConfig; project: ProjectRecord } {
  if (config.projects.some((project) => project.cwd === input.cwd)) {
    throw new Error(`addProject: ${JSON.stringify(input.cwd)} is already a project`)
  }
  const project: ProjectRecord = {
    id: newId(),
    name: input.name,
    slug: allocateSlug(
      input.name,
      config.projects.map((existing) => existing.slug),
    ),
    cwd: input.cwd,
    presets: [],
    activeTabId: null,
  }
  return {
    config: {
      ...config,
      projects: [...config.projects, project],
      // The first project added becomes the selected one; later ones do not
      // steal focus from wherever the user is working.
      activeProjectId: config.activeProjectId ?? project.id,
    },
    project,
  }
}

export function removeProject(config: PrcliConfig, id: string): PrcliConfig {
  const index = config.projects.findIndex((project) => project.id === id)
  if (index === -1) return config
  const projects = config.projects.filter((project) => project.id !== id)
  // Same neighbour rule the tab bar uses: prefer the one to the right.
  const neighbour = config.projects[index + 1] ?? config.projects[index - 1]
  return {
    ...config,
    projects,
    activeProjectId:
      config.activeProjectId === id ? (neighbour?.id ?? null) : config.activeProjectId,
    // Tabs are untouched on purpose. Their sessions are still running; they
    // simply stop matching a project and surface under Unsorted.
  }
}

export function updateProject(
  config: PrcliConfig,
  id: string,
  patch: { name?: string; presets?: Preset[] },
): PrcliConfig {
  if (!config.projects.some((project) => project.id === id)) return config
  return {
    ...config,
    projects: config.projects.map((project) =>
      project.id === id
        ? {
            ...project,
            name: patch.name ?? project.name,
            presets: patch.presets ?? project.presets,
            // `slug` is deliberately absent: it is baked into every session
            // name for this project, and re-slugging would orphan all of them.
          }
        : project,
    ),
  }
}

export function reorderProjects(config: PrcliConfig, ids: string[]): PrcliConfig {
  const byId = new Map(config.projects.map((project) => [project.id, project]))
  const ordered: ProjectRecord[] = []
  for (const id of ids) {
    const project = byId.get(id)
    if (!project) continue
    byId.delete(id)
    ordered.push(project)
  }
  // Anything the caller did not mention keeps its relative order at the end,
  // so a stale id list cannot silently delete a project.
  ordered.push(...byId.values())
  return { ...config, projects: ordered }
}

export function projectForSlug(config: PrcliConfig, slug: string): ProjectRecord | undefined {
  return config.projects.find((project) => project.slug === slug)
}
