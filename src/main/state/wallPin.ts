import type { PTermConfig } from './store'

/**
 * The config with `paneId`'s project pinned to `pin`.
 *
 * The pane's OWNER is resolved through `projectSlug`, the same route
 * `setActiveBrowser` takes (`register.ts:1093`), rather than trusting the
 * renderer to name a project: a pin is meaningless on a project that does not
 * hold the pane, and the pane already carries the only authority on which
 * project that is.
 *
 * A pane no project owns is a no-op rather than an error. Nothing the renderer
 * can do produces one, and the alternative is a rejection every caller would
 * have to handle for a case that costs a preference.
 */
export function withWallPin(
  config: PTermConfig,
  paneId: string,
  pin: string | null,
): PTermConfig {
  const pane = config.panes.find((saved) => saved.id === paneId)
  if (pane === undefined) return config
  const owner = config.projects.find((project) => project.slug === pane.projectSlug)
  if (owner === undefined) return config
  return {
    ...config,
    projects: config.projects.map((project) =>
      project.id === owner.id ? { ...project, wallPin: pin } : project,
    ),
  }
}

/** By project id, unlike `withWallPin`: the flag is the project's, not a pane's. */
export function withWallFollow(
  config: PTermConfig,
  projectId: string,
  follow: boolean,
): PTermConfig {
  if (!config.projects.some((project) => project.id === projectId)) return config
  return {
    ...config,
    projects: config.projects.map((project) =>
      project.id === projectId ? { ...project, wallFollowActive: follow } : project,
    ),
  }
}
