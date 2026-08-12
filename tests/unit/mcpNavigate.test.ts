import { describe, it, expect } from 'vitest'
import { planBrowserNavigate } from '../../src/main/mcp/navigate'
import type { RouteConfig } from '../../src/main/mcp/route'
import type { McpRequest } from '../../src/main/mcp/protocol'
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

function pane(
  overrides: Partial<TabDescriptor> & Pick<TabDescriptor, 'id' | 'type'>,
): TabDescriptor {
  return {
    projectSlug: 'demo',
    cwd: '/Users/paolo/demo',
    ...overrides,
  }
}

function request(overrides: Partial<McpRequest> = {}): McpRequest {
  return {
    id: 1,
    paneId: 'caller-1',
    tool: 'browser_navigate',
    args: { url: 'http://localhost:3000/' },
    ...overrides,
  }
}

/** A caller session with no browser pane of its own yet. */
const FRESH: RouteConfig = {
  projects: [project()],
  panes: [pane({ id: 'caller-1', type: 'claude' })],
}

/** The same caller, with the browser pane a previous call created for it. */
const OWNING: RouteConfig = {
  projects: [project()],
  panes: [
    pane({ id: 'caller-1', type: 'claude' }),
    pane({
      id: 'browser-1',
      type: 'browser',
      agentSessionId: 'caller-1',
      url: 'http://localhost:3000/',
    }),
  ],
}

describe('planBrowserNavigate', () => {
  it('asks for a pane to be created for a caller that owns none, carrying the URL to load after', () => {
    expect(planBrowserNavigate(FRESH, request())).toEqual({
      create: { projectSlug: 'demo', cwd: '/Users/paolo/demo' },
      url: 'http://localhost:3000/',
    })
  })

  it("reuses the caller's own browser pane once it has one", () => {
    expect(planBrowserNavigate(OWNING, request())).toEqual({
      paneId: 'browser-1',
      url: 'http://localhost:3000/',
    })
  })

  it('passes the routing failure through, naming the pane that was not found', () => {
    const plan = planBrowserNavigate(FRESH, request({ paneId: 'not-a-pane' }))

    expect(plan).toEqual({ error: expect.stringContaining('not-a-pane') })
  })

  // Requirement 1 of this task. `loadURL` from main emits no `will-navigate`,
  // so the pane-level confinement (`refusesNonLoopback`) never sees the URL a
  // tool call supplies. This check is the only thing standing between an
  // agent and any origin it likes.
  it('refuses a non-loopback URL argument outright, before any pane is created or navigated', () => {
    const plan = planBrowserNavigate(FRESH, request({ args: { url: 'https://example.com/' } }))

    expect(plan).toEqual({ error: expect.stringContaining('https://example.com/') })
  })

  it('refuses a bare host, which normalises to https and is therefore not loopback', () => {
    const plan = planBrowserNavigate(FRESH, request({ args: { url: 'example.com' } }))

    expect(plan).toEqual({ error: expect.stringContaining('example.com') })
  })

  it('refuses a non-http scheme that names loopback in its text', () => {
    const plan = planBrowserNavigate(
      FRESH,
      request({ args: { url: 'file:///Users/paolo/localhost/secrets' } }),
    )

    expect('error' in plan).toBe(true)
  })

  it('refuses a URL whose credentials name loopback but whose host does not', () => {
    const plan = planBrowserNavigate(
      FRESH,
      request({ args: { url: 'http://localhost@evil.example.com/' } }),
    )

    expect('error' in plan).toBe(true)
  })

  // The address bar's own rule, reused rather than reimplemented: a loopback
  // host typed without a scheme is http, so an agent may write it the way a
  // dev server prints it.
  it('accepts a bare loopback host and port, normalised to http', () => {
    expect(planBrowserNavigate(FRESH, request({ args: { url: 'localhost:5173' } }))).toEqual({
      create: { projectSlug: 'demo', cwd: '/Users/paolo/demo' },
      url: 'http://localhost:5173',
    })
  })

  it('refuses a missing url argument', () => {
    expect(planBrowserNavigate(FRESH, request({ args: {} }))).toEqual({
      error: expect.stringContaining('url'),
    })
  })

  it('refuses a url argument that is not a string', () => {
    expect(planBrowserNavigate(FRESH, request({ args: { url: 42 } }))).toEqual({
      error: expect.stringContaining('url'),
    })
  })

  it('refuses a tool it does not implement, naming it', () => {
    expect(planBrowserNavigate(FRESH, request({ tool: 'browser_back' }))).toEqual({
      error: expect.stringContaining('browser_back'),
    })
  })

  // Requirement 2 of this task. Nothing in this app claims a pane it did not
  // just create at `about:blank`, so this is defence for the one gap Task 7's
  // review left open (the window between a guest being created and the
  // renderer reporting it, where nothing refuses). If an owned pane is ever
  // found off loopback, driving it is refused rather than continued.
  it('refuses to drive an owned pane that is somehow off loopback', () => {
    const strayed: RouteConfig = {
      projects: [project()],
      panes: [
        pane({ id: 'caller-1', type: 'claude' }),
        pane({
          id: 'browser-1',
          type: 'browser',
          agentSessionId: 'caller-1',
          url: 'https://example.com/',
        }),
      ],
    }

    expect(planBrowserNavigate(strayed, request())).toEqual({
      error: expect.stringContaining('browser-1'),
    })
  })

  it('drives an owned pane that is still on the blank page it was created with', () => {
    const blank: RouteConfig = {
      projects: [project()],
      panes: [
        pane({ id: 'caller-1', type: 'claude' }),
        pane({ id: 'browser-1', type: 'browser', agentSessionId: 'caller-1', url: 'about:blank' }),
      ],
    }

    expect(planBrowserNavigate(blank, request())).toEqual({
      paneId: 'browser-1',
      url: 'http://localhost:3000/',
    })
  })

  it('drives an owned pane whose row carries no url at all', () => {
    const noUrl: RouteConfig = {
      projects: [project()],
      panes: [
        pane({ id: 'caller-1', type: 'claude' }),
        pane({ id: 'browser-1', type: 'browser', agentSessionId: 'caller-1' }),
      ],
    }

    expect(planBrowserNavigate(noUrl, request())).toEqual({
      paneId: 'browser-1',
      url: 'http://localhost:3000/',
    })
  })
})
