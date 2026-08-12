import type { ProjectDescriptor, TabDescriptor } from '../../shared/ipc'

/**
 * Everything `browserPaneFor` needs to route a request: the same shapes
 * `list()`-style IPC calls already hand the renderer (`ProjectDescriptor[]`
 * and `TabDescriptor[]`, both in `shared/ipc.ts`), not a parallel
 * vocabulary. This function creates nothing, mutates nothing and performs
 * no IPC; it only reads these two arrays.
 */
export interface RouteConfig {
  projects: ProjectDescriptor[]
  panes: TabDescriptor[]
}

/**
 * Where an MCP browser tool call from `paneId` should go.
 *
 * `paneId` is the calling Claude session's own pane id, carried into its
 * tmux environment as `PTERM_TAB_ID`. The rule: that pane names a session;
 * the session's project is found by its `projectSlug`; the browser pane
 * belonging to that SESSION is the one whose `agentSessionId` equals the
 * calling pane id.
 *
 * A browser pane with no `agentSessionId` at all, the shape a pane the user
 * opened by hand always has, is never matched here: filtering on
 * `agentSessionId === paneId` excludes it exactly as it excludes a browser
 * pane owned by a different session. That is the decision made in
 * brainstorming: the agent drives its own browser pane, never the user's.
 *
 * Returns the existing pane's id when the session already has one, asks the
 * caller to create one (naming the project to create it in) when it does
 * not, or names what could not be found when the caller itself is unknown.
 */
export function browserPaneFor(
  config: RouteConfig,
  paneId: string,
): { paneId: string } | { create: { projectSlug: string; cwd: string } } | { error: string } {
  const caller = config.panes.find((pane) => pane.id === paneId)
  if (!caller) return { error: `no pane with id ${paneId}` }

  const project = config.projects.find((project) => project.slug === caller.projectSlug)
  if (!project) return { error: `no project with slug ${caller.projectSlug}` }

  const own = config.panes.find(
    (pane) => pane.type === 'browser' && pane.projectSlug === caller.projectSlug && pane.agentSessionId === paneId,
  )
  if (own) return { paneId: own.id }

  return { create: { projectSlug: project.slug, cwd: project.cwd } }
}
