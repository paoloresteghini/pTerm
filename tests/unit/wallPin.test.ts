import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, type ProjectRecord } from '../../src/main/state/store'
import { describeProjects } from '../../src/main/ipc/restore'

/**
 * The wall pin, and the version bump that carries it.
 *
 * A pin is a fact about a PROJECT (which pane it shows on the wall), so it
 * lives in the config beside `activeTabId`. Slot membership is a fact about
 * this window's layout and lives in `localStorage`; see `wallSlots.ts`.
 *
 * Read through `ConfigStore` rather than by calling `normaliseProject`
 * directly, because the tolerance being tested is the one a hand-edited file
 * meets: the field arrives as `unknown` off JSON, and the type says otherwise.
 *
 * Sabotage-checked (2026-08-17), each mutation applied and reverted by hand:
 * 1. hardcoded `wallPin: null` in `normaliseProject`: reddened "round-trips a
 *    set pin" and "writes the pin back out" (both expected a set string back
 *    and got `null`). Did NOT redden "normalises a non-string pin to null",
 *    which already expects `null` and cannot tell a correct default from a
 *    mutated one that always returns it.
 * 2. hardcoded `wallFollowActive: false` in `normaliseProject`: reddened
 *    exactly "round-trips the follow flag", as expected.
 * 3. dropped `wallPin` from `describeProjects` (`src/main/ipc/restore.ts`):
 *    "round-trips a set pin" reads through `ConfigStore` directly and did NOT
 *    redden, since this file's other tests never call `describeProjects`.
 *    Neither did any pre-existing suite: no test anywhere asserted on
 *    `ProjectDescriptor.wallPin`. Added "describeProjects carries the pin"
 *    below as this mutation's witness; with the field dropped, both its tests
 *    reddened (`described[0]?.wallPin` came back `undefined` instead of
 *    `'pane-1'` and `null`).
 * All three mutations were reverted and the suite confirmed green again
 * before implementation was considered final.
 */

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-wallpin-'))
  file = join(dir, 'config.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function storeWith(raw: unknown): Promise<ConfigStore> {
  await writeFile(file, JSON.stringify(raw), 'utf8')
  return new ConfigStore(file)
}

/** A project row as a given version would have written it. */
function projectRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Lumio',
    slug: 'lumio',
    cwd: '/Users/paolo/Code/Lumio',
    presets: [],
    activeTabId: null,
    activeBrowserTabId: null,
    ...extra,
  }
}

function configAt(version: number, extra: Record<string, unknown> = {}) {
  return {
    version,
    activeProjectId: 'p1',
    projects: [projectRow(extra)],
    panes: [],
    tabs: [],
  }
}

describe('config v9 to v10', () => {
  it('reads a v9 file with no wall fields as unpinned', async () => {
    const config = await (await storeWith(configAt(9))).read()
    expect(config.version).toBe(10)
    expect(config.projects[0]?.wallPin).toBeNull()
    expect(config.projects[0]?.wallFollowActive).toBe(false)
  })

  it('round-trips a set pin', async () => {
    const config = await (await storeWith(configAt(10, { wallPin: 'pane-1' }))).read()
    expect(config.projects[0]?.wallPin).toBe('pane-1')
  })

  it('round-trips the follow flag', async () => {
    const config = await (await storeWith(configAt(10, { wallFollowActive: true }))).read()
    expect(config.projects[0]?.wallFollowActive).toBe(true)
  })

  // A hand-edited `"wallPin": 7` must not reach the renderer as a pane id: it
  // would be compared against `pane.id` and match nothing, which is the same
  // outcome as null by luck rather than by rule.
  it('normalises a non-string pin to null', async () => {
    const config = await (await storeWith(configAt(10, { wallPin: 7 }))).read()
    expect(config.projects[0]?.wallPin).toBeNull()
  })

  it('normalises a non-boolean follow flag to false', async () => {
    const config = await (await storeWith(configAt(10, { wallFollowActive: 'yes' }))).read()
    expect(config.projects[0]?.wallFollowActive).toBe(false)
  })

  it('writes the pin back out', async () => {
    const store = await storeWith(configAt(10))
    const config = await store.read()
    await store.write({
      ...config,
      projects: config.projects.map((project) => ({ ...project, wallPin: 'pane-2' })),
    })
    expect((await store.read()).projects[0]?.wallPin).toBe('pane-2')
  })

  // Unchanged behaviour from `store.ts:477`, asserted here because the version
  // branch this task widens is the one that decides it.
  it('still refuses a version from the future', async () => {
    const config = await (await storeWith(configAt(11))).read()
    expect(config.projects).toEqual([])
  })
})

describe('describeProjects carries the pin', () => {
  function recordFor(id: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
    return {
      id,
      name: 'Lumio',
      slug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      presets: [],
      activeTabId: null,
      activeBrowserTabId: null,
      wallPin: null,
      wallFollowActive: false,
      ...extra,
    }
  }

  // Not resolved against live panes: a pin naming a pane no tab holds must
  // still come through, since a missing pane and no pin are the two states
  // the renderer draws differently. `tabs: []` here is exactly that case.
  it('passes an unresolved pin through rather than nulling it', async () => {
    const described = await describeProjects(
      [recordFor('p1', { wallPin: 'pane-1', wallFollowActive: true })],
      [],
    )
    expect(described[0]?.wallPin).toBe('pane-1')
    expect(described[0]?.wallFollowActive).toBe(true)
  })

  it('carries null through for an unpinned project', async () => {
    const described = await describeProjects([recordFor('p1')], [])
    expect(described[0]?.wallPin).toBeNull()
    expect(described[0]?.wallFollowActive).toBe(false)
  })
})
