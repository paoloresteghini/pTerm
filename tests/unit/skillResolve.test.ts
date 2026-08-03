import { describe, it, expect } from 'vitest'
import { pluginSkillDirs } from '../../src/main/skills/resolve'

const LUMIO = '/Users/paolo/Code/Lumio'
const OTHER = '/Users/paolo/Code/PRCLI'

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

describe('pluginSkillDirs', () => {
  it('takes the project-scoped install when the project matches', () => {
    const dirs = pluginSkillDirs(enabled, registry, LUMIO)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.map((entry) => entry.dir)).toContain('/cache/superpowers/6.1.1/skills')
    expect(dirs.map((entry) => entry.dir)).not.toContain('/cache/superpowers/6.2.0/skills')
  })

  it('falls back to the user-scoped install for any other project', () => {
    const dirs = pluginSkillDirs(enabled, registry, OTHER)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.map((entry) => entry.dir)).toContain('/cache/superpowers/6.2.0/skills')
    expect(dirs.map((entry) => entry.dir)).not.toContain('/cache/superpowers/6.1.1/skills')
  })

  it('omits a plugin whose flag is false rather than merely absent', () => {
    const dirs = pluginSkillDirs(enabled, registry, OTHER)
    expect(dirs.length).toBeGreaterThan(0)
    for (const entry of dirs) {
      expect(entry.dir).not.toContain('security-guidance')
    }
  })

  it('names the plugin without its marketplace suffix', () => {
    const dirs = pluginSkillDirs(enabled, registry, OTHER)
    const found = dirs.find((entry) => entry.dir.includes('frontend-design'))
    expect(found).toBeDefined()
    expect(found?.source).toEqual({ kind: 'plugin', plugin: 'frontend-design' })
  })

  it('omits an enabled plugin the registry does not list', () => {
    const dirs = pluginSkillDirs({ 'ghost@nowhere': true }, registry, OTHER)
    expect(dirs).toEqual([])
  })

  it('omits a plugin with no install this project can use', () => {
    const onlyOtherProject = {
      version: 2,
      plugins: {
        'scoped@m': [{ scope: 'project', projectPath: LUMIO, installPath: '/cache/scoped' }],
      },
    }
    expect(pluginSkillDirs({ 'scoped@m': true }, onlyOtherProject, OTHER)).toEqual([])
  })

  it('contributes nothing when either input is the wrong shape', () => {
    expect(pluginSkillDirs(null, registry, OTHER)).toEqual([])
    expect(pluginSkillDirs(enabled, 'not an object', OTHER)).toEqual([])
    expect(pluginSkillDirs(enabled, { plugins: 'wrong' }, OTHER)).toEqual([])
  })
})
