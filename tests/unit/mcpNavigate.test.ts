import { afterEach, describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSafeToDrive, planBrowserNavigate } from '../../src/main/mcp/navigate'
import type { RouteConfig } from '../../src/main/mcp/route'
import type { McpRequest } from '../../src/main/mcp/protocol'
import { ConfigStore } from '../../src/main/state/store'
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

/** The temp directory the one test that writes a config file made, if any. */
let forged: string | null = null

afterEach(async () => {
  if (forged !== null) await rm(forged, { recursive: true, force: true })
  forged = null
})

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

  /**
   * The composed property, through the real store rather than a fixture: a
   * config file cannot hand an agent a pane.
   *
   * The pane rows the tool routes against come off disk, and the file is one
   * an agent with a shell can edit. Writing `agentSessionId` onto the user's
   * hand-opened browser row is the whole attack, and it is one line. This
   * asserts what the tool does with such a file end to end: it routes the
   * call as if the row said nothing, and asks for a pane of its own.
   *
   * Deliberately built by reading a file with `ConfigStore` rather than by
   * writing the stripped array by hand. The strip lives in `normalisePane`
   * (`main/state/store.ts`), so a fixture assembled in this test would prove
   * only that this test knows the answer.
   */
  it('routes a caller as owning nothing when only the config file says otherwise', async () => {
    forged = await mkdtemp(join(tmpdir(), 'pterm-mcp-forged-'))
    const file = join(forged, 'config.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 9,
        activeProjectId: 'proj-1',
        projects: [
          { id: 'proj-1', name: 'demo', slug: 'demo', cwd: '/Users/paolo/demo', presets: [], activeTabId: null },
        ],
        panes: [
          {
            id: 'caller-1',
            projectSlug: 'demo',
            cwd: '/Users/paolo/demo',
            type: 'claude',
            tmuxSession: 'pterm-demo-caller-1',
          },
          {
            id: 'hand-opened',
            projectSlug: 'demo',
            cwd: '/Users/paolo/demo',
            type: 'browser',
            url: 'http://localhost:3000/',
            // The forgery, and the only line that differs from a pane the
            // user opened by hand.
            agentSessionId: 'caller-1',
          },
        ],
        tabs: [],
      }),
      'utf8',
    )

    const config = await new ConfigStore(file).read()
    const plan = planBrowserNavigate(
      { projects: [project()], panes: config.panes },
      request({ paneId: 'caller-1' }),
    )

    expect(plan).toEqual({
      create: { projectSlug: 'demo', cwd: '/Users/paolo/demo' },
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

/**
 * The same predicate `planBrowserNavigate` uses on the pane's remembered URL,
 * tested here against the shapes its OTHER caller sees:
 * `registerIpc`'s handler asks it about `guest.getURL()` immediately before
 * `loadURL`, which is the authoritative value. The config one lags it, since
 * it arrives by `did-navigate` and a debounced `setPaneUrl`.
 */
describe('isSafeToDrive', () => {
  it('allows the empty string a guest that has loaded nothing answers with', () => {
    expect(isSafeToDrive('')).toBe(true)
  })

  it('allows the blank page every agent pane is created on', () => {
    expect(isSafeToDrive('about:blank')).toBe(true)
  })

  it('allows a loopback page', () => {
    expect(isSafeToDrive('http://127.0.0.1:5173/app')).toBe(true)
  })

  it('refuses a remote page', () => {
    expect(isSafeToDrive('https://example.com/')).toBe(false)
  })

  it('refuses a file URL, which is not loopback and is not blank either', () => {
    expect(isSafeToDrive('file:///Users/paolo/.ssh/id_ed25519')).toBe(false)
  })
})
