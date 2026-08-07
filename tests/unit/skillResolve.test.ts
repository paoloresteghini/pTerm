import { describe, it, expect } from 'vitest'
import { pluginRoots } from '../../src/main/skills/resolve'

const LUMIO = '/Users/paolo/Code/Lumio'
const OTHER = '/Users/paolo/Code/pTerm'

/** The real registry's shape, reduced to the one plugin that has two installs. */
const registry = {
  version: 2,
  plugins: {
    'superpowers@claude-plugins-official': [
      { scope: 'project', projectPath: LUMIO, installPath: '/cache/superpowers/6.1.1' },
      { scope: 'user', installPath: '/cache/superpowers/6.2.0' },
    ],
    'frontend-design@claude-plugins-official': [
      { scope: 'user', installPath: '/cache/frontend-design/unknown' },
    ],
    'security-guidance@claude-plugins-official': [
      { scope: 'user', installPath: '/cache/security-guidance/1.0.0' },
    ],
  },
}

const enabled = {
  'superpowers@claude-plugins-official': true,
  'frontend-design@claude-plugins-official': true,
  // Really present and really false on the target machine. This is the case
  // a key-presence check gets wrong.
  'security-guidance@claude-plugins-official': false,
}

describe('pluginRoots', () => {
  it('returns the install root itself, not a subdirectory of it', () => {
    // The root, because a plugin contributes BOTH `skills/` and `commands/`
    // and the caller joins whichever it is reading. Returning
    // `<installPath>/skills` is what made plugin commands unreachable.
    const roots = pluginRoots(enabled, registry, OTHER)
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.map((entry) => entry.base)).toContain('/cache/superpowers/6.2.0')
    for (const entry of roots) {
      expect(entry.base.endsWith('/skills')).toBe(false)
    }
  })

  it('takes the project-scoped install when the project matches', () => {
    const roots = pluginRoots(enabled, registry, LUMIO)
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.map((entry) => entry.base)).toContain('/cache/superpowers/6.1.1')
    expect(roots.map((entry) => entry.base)).not.toContain('/cache/superpowers/6.2.0')
  })

  it('falls back to the user-scoped install for any other project', () => {
    const roots = pluginRoots(enabled, registry, OTHER)
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.map((entry) => entry.base)).toContain('/cache/superpowers/6.2.0')
    expect(roots.map((entry) => entry.base)).not.toContain('/cache/superpowers/6.1.1')
  })

  it('omits a plugin whose flag is false rather than merely absent', () => {
    const roots = pluginRoots(enabled, registry, OTHER)
    expect(roots.length).toBeGreaterThan(0)
    for (const entry of roots) {
      expect(entry.base).not.toContain('security-guidance')
    }
  })

  it('names the plugin without its marketplace suffix', () => {
    const roots = pluginRoots(enabled, registry, OTHER)
    const found = roots.find((entry) => entry.base.includes('frontend-design'))
    expect(found).toBeDefined()
    expect(found?.source).toEqual({ kind: 'plugin', plugin: 'frontend-design' })
  })

  it('omits an enabled plugin the registry does not list', () => {
    expect(pluginRoots({ 'ghost@nowhere': true }, registry, OTHER)).toEqual([])
  })

  it('omits a plugin with no install this project can use', () => {
    const onlyOtherProject = {
      version: 2,
      plugins: {
        'scoped@m': [{ scope: 'project', projectPath: LUMIO, installPath: '/cache/scoped' }],
      },
    }
    expect(pluginRoots({ 'scoped@m': true }, onlyOtherProject, OTHER)).toEqual([])
  })

  it('contributes nothing when either input is the wrong shape', () => {
    expect(pluginRoots(null, registry, OTHER)).toEqual([])
    expect(pluginRoots(enabled, 'not an object', OTHER)).toEqual([])
    expect(pluginRoots(enabled, { plugins: 'wrong' }, OTHER)).toEqual([])
  })
})
