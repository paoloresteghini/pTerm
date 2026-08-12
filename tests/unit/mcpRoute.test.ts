import { describe, it, expect } from 'vitest'
import { browserPaneFor, type RouteConfig } from '../../src/main/mcp/route'
import type { ProjectDescriptor, TabDescriptor } from '../../src/shared/ipc'

function project(overrides: Partial<ProjectDescriptor> = {}): ProjectDescriptor {
  return {
    id: 'proj-1',
    name: 'demo',
    slug: 'demo',
    cwd: '/Users/paolo/demo',
    presets: [],
    activeTabId: null,
    available: true,
    ...overrides,
  }
}

function pane(overrides: Partial<TabDescriptor> & Pick<TabDescriptor, 'id' | 'type'>): TabDescriptor {
  return {
    projectSlug: 'demo',
    cwd: '/Users/paolo/demo',
    ...overrides,
  }
}

describe('browserPaneFor', () => {
  it('errors on an unknown pane id, naming what was not found', () => {
    const config: RouteConfig = { projects: [project()], panes: [] }

    const result = browserPaneFor(config, 'no-such-pane')

    expect(result).toEqual({ error: expect.stringContaining('no-such-pane') })
  })

  it('asks the caller to create a browser pane when their project has none, using the project cwd not the caller pane cwd', () => {
    const config: RouteConfig = {
      projects: [project({ slug: 'demo', cwd: '/Users/paolo/demo' })],
      panes: [pane({ id: 'caller-1', type: 'claude', projectSlug: 'demo', cwd: '/Users/paolo/demo/subdir' })],
    }

    const result = browserPaneFor(config, 'caller-1')

    expect(result).toEqual({ create: { projectSlug: 'demo', cwd: '/Users/paolo/demo' } })
  })

  it('errors when the caller pane names a project no longer in the live config, naming the missing slug', () => {
    const config: RouteConfig = {
      projects: [],
      panes: [pane({ id: 'caller-1', type: 'claude', projectSlug: 'removed-project' })],
    }

    const result = browserPaneFor(config, 'caller-1')

    expect(result).toEqual({ error: expect.stringContaining('removed-project') })
  })

  it("returns the session's existing browser pane", () => {
    const config: RouteConfig = {
      projects: [project({ slug: 'demo' })],
      panes: [
        pane({ id: 'caller-1', type: 'claude', projectSlug: 'demo' }),
        pane({ id: 'browser-1', type: 'browser', projectSlug: 'demo', agentSessionId: 'caller-1' }),
      ],
    }

    const result = browserPaneFor(config, 'caller-1')

    expect(result).toEqual({ paneId: 'browser-1' })
  })

  it("returns only the caller's browser pane when other sessions in the same project have their own", () => {
    const config: RouteConfig = {
      projects: [project({ slug: 'demo' })],
      panes: [
        pane({ id: 'caller-1', type: 'claude', projectSlug: 'demo' }),
        pane({ id: 'caller-2', type: 'claude', projectSlug: 'demo' }),
        pane({ id: 'browser-1', type: 'browser', projectSlug: 'demo', agentSessionId: 'caller-1' }),
        pane({ id: 'browser-2', type: 'browser', projectSlug: 'demo', agentSessionId: 'caller-2' }),
      ],
    }

    const result = browserPaneFor(config, 'caller-1')

    expect(result).toEqual({ paneId: 'browser-1' })
  })

  // The case that protects the decision from brainstorming: the agent
  // drives its own browser pane, never the user's. A browser pane the user
  // opened by hand carries no agentSessionId at all, and must never come
  // back for any caller, even the only session in the project.
  it('never returns a browser pane the user opened by hand', () => {
    const config: RouteConfig = {
      projects: [project({ slug: 'demo', cwd: '/Users/paolo/demo' })],
      panes: [
        pane({ id: 'caller-1', type: 'claude', projectSlug: 'demo' }),
        pane({ id: 'hand-opened', type: 'browser', projectSlug: 'demo' }),
      ],
    }

    const result = browserPaneFor(config, 'caller-1')

    expect(result).toEqual({ create: { projectSlug: 'demo', cwd: '/Users/paolo/demo' } })
  })

  // The project half of the match, which no test above isolates: every one of
  // them has the caller and its browser pane in the same project, so deleting
  // `pane.projectSlug === caller.projectSlug` from the filter passed all six.
  //
  // The two halves are not the same question. `agentSessionId` says which
  // SESSION owns the pane; `projectSlug` says which PROJECT the pane is filed
  // under, and it is the field every other pane lookup in `register.ts`
  // scopes on. The pane rows come off disk while ownership is a runtime map
  // keyed by pane id alone, so nothing in the type system keeps the two in
  // step, and a routing rule that answered with a pane outside the caller's
  // project would put an agent's page in another project's column.
  it('does not return an owned browser pane filed under another project', () => {
    const config: RouteConfig = {
      projects: [project({ slug: 'demo', cwd: '/Users/paolo/demo' })],
      panes: [
        pane({ id: 'caller-1', type: 'claude', projectSlug: 'demo' }),
        pane({ id: 'browser-1', type: 'browser', projectSlug: 'other', agentSessionId: 'caller-1' }),
      ],
    }

    const result = browserPaneFor(config, 'caller-1')

    expect(result).toEqual({ create: { projectSlug: 'demo', cwd: '/Users/paolo/demo' } })
  })
})
