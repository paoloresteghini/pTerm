import type { TabDescriptor } from '../../shared/ipc'
import type { HookLine } from '../hooks/protocol'
import type { StatusRegistry } from './registry'

export interface HookInboxDeps {
  registry: StatusRegistry
  /** Whether a client for this tab is attached in this app right now. */
  isOpen: (tabId: string) => boolean
  /** The saved tab rows — read per event, because a detach never removes one. */
  readTabs: () => Promise<TabDescriptor[]>
}

export interface HookInbox {
  /** Resolves once the event has been applied, or deliberately dropped. */
  handle: (message: HookLine) => Promise<void>
}

/**
 * Everything that happens to an event between the socket and the registry.
 *
 * Extracted from `index.ts` so it can be tested at all: the app bootstrap has
 * no seam, and the ordering guarantee below is invisible to every other kind
 * of test.
 *
 * Two rules live here.
 *
 * **Membership.** `parseHookLine` validates the *shape* of a tab id — sixteen
 * hex characters — not that it names a tab this app has, and the socket is
 * reachable by anything on the machine that can open it. An event for an
 * unknown id would otherwise create a registry entry nothing in the UI can
 * ever reach to dismiss, leaving the dock badge off by one for the rest of the
 * run. Checked against both the manager and the saved config, never one:
 * `isOpen` alone misses a tab detached earlier in this run — still alive, and
 * still meant to keep updating — and the config alone misses a tab opened
 * moments ago, before its `rememberTab` write has landed.
 *
 * **Order.** A detached tab's event costs an `await` on the config before it
 * can be applied, and two events arriving close together then raced: whichever
 * read resolved first won, so the *earlier* event could land last and strand a
 * permanent `waiting` — with the dock badge counting it — on a session that
 * had already gone quiet. Every event now queues behind the one before it, so
 * arrival order is the order they are applied in, whatever the reads do.
 *
 * The queue is a promise chain rather than the config write queue in
 * `register.ts`: that one has no reentrancy protection and a hook event can
 * fire from anywhere at any time, so borrowing it would risk a deadlock for
 * something a delayed dot should never be able to cause.
 */
export function createHookInbox(deps: HookInboxDeps): HookInbox {
  let queue: Promise<void> = Promise.resolve()

  const apply = (message: HookLine): void => {
    if (message.event === 'Exit') {
      deps.registry.applyDead(message.tabId, { status: message.status, signal: message.signal })
      return
    }
    deps.registry.applyHook(message)
  }

  const admit = async (message: HookLine): Promise<void> => {
    if (deps.isOpen(message.tabId)) {
      apply(message)
      return
    }
    const tabs = await deps.readTabs()
    if (tabs.some((tab) => tab.id === message.tabId)) apply(message)
  }

  return {
    handle(message) {
      // Errors are contained rather than propagated: a failed config read must
      // not break the chain for every event after it, and there is no caller
      // to report to — this is the far end of a socket.
      queue = queue.then(() =>
        admit(message).catch((error: unknown) => {
          console.warn('pTerm: dropped a hook event', error)
        }),
      )
      return queue
    },
  }
}
