import { describe, it, expect } from 'vitest'
import { createHookInbox } from '../../src/main/status/inbox'
import { StatusRegistry } from '../../src/main/status/registry'
import type { TabDescriptor } from '../../src/shared/ipc'
import type { HookLine } from '../../src/main/hooks/protocol'

const ID = '0123456789abcdef'

function tab(id: string): TabDescriptor {
  return {
    id,
    projectSlug: 'lumio',
    cwd: '/tmp',
    tmuxSession: `prcli-lumio-${id}`,
    type: 'claude',
  }
}

function hook(tabId: string, event: 'Notification' | 'Stop'): HookLine {
  return { tabId, event, at: 1 }
}

describe('createHookInbox', () => {
  it('applies an event for a tab the manager has open', async () => {
    const registry = new StatusRegistry()
    const inbox = createHookInbox({
      registry,
      isOpen: () => true,
      readTabs: async () => [],
    })

    await inbox.handle(hook(ID, 'Notification'))

    expect(registry.get(ID)).toBe('waiting')
  })

  it('applies an event for a detached tab that is only in the saved config', async () => {
    const registry = new StatusRegistry()
    const inbox = createHookInbox({
      registry,
      isOpen: () => false,
      readTabs: async () => [tab(ID)],
    })

    await inbox.handle(hook(ID, 'Notification'))

    expect(registry.get(ID)).toBe('waiting')
  })

  it('ignores an event for a tab nothing knows about', async () => {
    const registry = new StatusRegistry()
    const inbox = createHookInbox({
      registry,
      isOpen: () => false,
      readTabs: async () => [],
    })

    await inbox.handle(hook(ID, 'Notification'))

    // An id nothing can reach from the UI would inflate the dock badge for the
    // rest of the run — the same membership check I5 added, kept here.
    expect(registry.get(ID)).toBeNull()
  })

  it('records a dead pane by the status it reported', async () => {
    const registry = new StatusRegistry()
    const inbox = createHookInbox({
      registry,
      isOpen: () => true,
      readTabs: async () => [],
    })

    await inbox.handle({ tabId: ID, event: 'Exit', status: 3, at: 1 })

    expect(registry.get(ID)).toBe('crashed')
  })

  // The defect this module exists to remove. A detached tab's event costs an
  // `await` on the config before it can be applied, so two events arriving
  // close together used to race: whichever read resolved first won, and the
  // *earlier* event could land last — stranding a permanent `waiting` and an
  // inflated dock badge for a session that had already gone quiet.
  it('applies events in the order they arrived, however the reads resolve', async () => {
    const registry = new StatusRegistry()
    let call = 0
    const inbox = createHookInbox({
      registry,
      isOpen: () => false,
      readTabs: async () => {
        // The first read is the slow one, so a handler that does not serialise
        // finishes the second event first and then overwrites it with the
        // first.
        const delay = call++ === 0 ? 30 : 0
        await new Promise((resolve) => setTimeout(resolve, delay))
        return [tab(ID)]
      },
    })

    const first = inbox.handle(hook(ID, 'Notification'))
    const second = inbox.handle(hook(ID, 'Stop'))
    await Promise.all([first, second])

    // `Stop` arrived second and means idle. A permanent `waiting` here is the
    // stranded badge.
    expect(registry.get(ID)).toBe('idle')
  })
})
