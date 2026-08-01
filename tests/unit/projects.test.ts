import { describe, it, expect } from 'vitest'
import {
  UNSORTED_ID,
  allocateSlug,
  addProject,
  removeProject,
  updateProject,
  reorderProjects,
  projectForSlug,
} from '../../src/main/projects/projects'
import { DEFAULT_NOTIFICATIONS, type PrcliConfig } from '../../src/main/state/store'

const EMPTY: PrcliConfig = {
  version: 5,
  projects: [],
  activeProjectId: null,
  panes: [],
  tabs: [],
  notifications: DEFAULT_NOTIFICATIONS,
}

function withProjects(...names: string[]): PrcliConfig {
  return names.reduce<PrcliConfig>(
    (config, name) => addProject(config, { name, cwd: `/tmp/${name}` }).config,
    EMPTY,
  )
}

describe('allocateSlug', () => {
  it('slugifies the name when nothing is taken', () => {
    expect(allocateSlug('Lumio', [])).toBe('lumio')
  })

  it('separates a collision discriminator with an underscore, not a dash', () => {
    // names.ts defines slugs as /^[a-z0-9_]+$/ and decodes a session name by
    // splitting into exactly three dash-separated parts, so a dash here would
    // break encodeSessionName and decodeSessionName both.
    expect(allocateSlug('api', ['api'])).toBe('api_2')
  })

  it('keeps counting past the first collision', () => {
    expect(allocateSlug('api', ['api', 'api_2'])).toBe('api_3')
  })

  it('refuses the reserved Unsorted slug', () => {
    expect(allocateSlug('Unsorted', [])).toBe('unsorted_2')
  })

  it('produces a slug that survives a session-name round trip', () => {
    expect(allocateSlug('GCO — Queue Worker!', [])).toMatch(/^[a-z0-9_]+$/)
  })
})

describe('addProject', () => {
  it('appends to the end, which is sidebar order', () => {
    const config = withProjects('Adecco', 'Lumio')
    expect(config.projects.map((p) => p.name)).toEqual(['Adecco', 'Lumio'])
  })

  it('gives the first project focus when there was none', () => {
    const { config, project } = addProject(EMPTY, { name: 'Lumio', cwd: '/tmp/lumio' })
    expect(config.activeProjectId).toBe(project.id)
  })

  it('leaves the active project alone when one is already selected', () => {
    const first = withProjects('Adecco')
    const after = addProject(first, { name: 'Lumio', cwd: '/tmp/lumio' }).config
    expect(after.activeProjectId).toBe(first.activeProjectId)
  })

  it('gives every project a distinct id', () => {
    const config = withProjects('Adecco', 'Lumio')
    expect(new Set(config.projects.map((p) => p.id)).size).toBe(2)
  })

  it('starts a project with no presets and no active tab', () => {
    const { project } = addProject(EMPTY, { name: 'Lumio', cwd: '/tmp/lumio' })
    expect(project.presets).toEqual([])
    expect(project.activeTabId).toBeNull()
  })

  it('refuses a folder that is already a project', () => {
    const config = addProject(EMPTY, { name: 'Lumio', cwd: '/tmp/lumio' }).config
    expect(() => addProject(config, { name: 'Other', cwd: '/tmp/lumio' })).toThrow(/already/i)
  })

  it('discriminates a slug collision between two projects', () => {
    const config = withProjects('api', 'API')
    expect(config.projects.map((p) => p.slug)).toEqual(['api', 'api_2'])
  })
})

describe('removeProject', () => {
  it('removes the row', () => {
    const config = withProjects('Adecco', 'Lumio')
    const after = removeProject(config, config.projects[0].id)
    expect(after.projects.map((p) => p.name)).toEqual(['Lumio'])
  })

  // The sessions keep running; restore lists them under Unsorted because
  // their slug no longer matches anything. Nothing here should touch panes.
  it('leaves the panes alone', () => {
    const config: PrcliConfig = {
      ...withProjects('Lumio'),
      panes: [
        {
          id: 'a1b2c3d4e5f60718',
          projectSlug: 'lumio',
          cwd: '/tmp/lumio',
          tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
          type: 'shell',
        },
      ],
    }
    const after = removeProject(config, config.projects[0].id)
    expect(after.panes).toEqual(config.panes)
  })

  it('moves focus to the neighbour when the active project goes', () => {
    const config = withProjects('Adecco', 'Lumio')
    const after = removeProject(config, config.projects[0].id)
    expect(after.activeProjectId).toBe(config.projects[1].id)
  })

  it('leaves nothing active when the last project goes', () => {
    const config = withProjects('Lumio')
    expect(removeProject(config, config.projects[0].id).activeProjectId).toBeNull()
  })

  it('ignores an unknown id', () => {
    const config = withProjects('Lumio')
    expect(removeProject(config, 'nope')).toEqual(config)
  })
})

describe('updateProject', () => {
  it('renames without touching the slug, which is baked into session names', () => {
    const config = withProjects('Lumio')
    const after = updateProject(config, config.projects[0].id, { name: 'Lumio Ltd' })
    expect(after.projects[0].name).toBe('Lumio Ltd')
    expect(after.projects[0].slug).toBe('lumio')
  })

  it('replaces the preset list', () => {
    const config = withProjects('Lumio')
    const presets = [{ id: 'pr1', label: 'dev', command: 'npm run dev' }]
    const after = updateProject(config, config.projects[0].id, { presets })
    expect(after.projects[0].presets).toEqual(presets)
  })

  it('ignores an unknown id', () => {
    const config = withProjects('Lumio')
    expect(updateProject(config, 'nope', { name: 'x' })).toEqual(config)
  })
})

describe('reorderProjects', () => {
  it('reorders to the given sequence', () => {
    const config = withProjects('Adecco', 'Lumio', 'GCO')
    const [a, l, g] = config.projects.map((p) => p.id)
    const after = reorderProjects(config, [g, a, l])
    expect(after.projects.map((p) => p.name)).toEqual(['GCO', 'Adecco', 'Lumio'])
  })

  it('appends anything the caller left out rather than dropping it', () => {
    const config = withProjects('Adecco', 'Lumio', 'GCO')
    const [, l] = config.projects.map((p) => p.id)
    const after = reorderProjects(config, [l])
    expect(after.projects.map((p) => p.name)).toEqual(['Lumio', 'Adecco', 'GCO'])
  })

  it('ignores ids that are not projects', () => {
    const config = withProjects('Adecco')
    expect(reorderProjects(config, ['nope']).projects.map((p) => p.name)).toEqual(['Adecco'])
  })
})

describe('projectForSlug', () => {
  it('finds the owner of a slug', () => {
    const config = withProjects('Lumio')
    expect(projectForSlug(config, 'lumio')?.name).toBe('Lumio')
  })

  it('returns undefined for a slug no project owns — that is what Unsorted means', () => {
    expect(projectForSlug(withProjects('Lumio'), 'scratch')).toBeUndefined()
  })

  it('never matches the reserved Unsorted id', () => {
    expect(projectForSlug(withProjects('Lumio'), UNSORTED_ID)).toBeUndefined()
  })
})

describe('immutability', () => {
  it('never mutates the config it is given', () => {
    const config = withProjects('Adecco', 'Lumio')
    const before = JSON.stringify(config)
    addProject(config, { name: 'GCO', cwd: '/tmp/gco' })
    removeProject(config, config.projects[0].id)
    updateProject(config, config.projects[0].id, { name: 'x' })
    reorderProjects(config, [config.projects[1].id])
    expect(JSON.stringify(config)).toBe(before)
  })
})
