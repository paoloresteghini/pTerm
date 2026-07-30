import type { TabDescriptor } from '../shared/ipc'

export interface TabsState {
  tabs: TabDescriptor[]
  activeId: string | null
}

export type TabsAction =
  | { type: 'restored'; tabs: TabDescriptor[]; activeId: string | null }
  | { type: 'opened'; tab: TabDescriptor }
  | { type: 'removed'; id: string }
  | { type: 'activated'; id: string }

export const INITIAL_TABS_STATE: TabsState = { tabs: [], activeId: null }

/**
 * Which tab to show once `id` goes away: the one to its right, or its left
 * when it was last. Null when it was the only one.
 */
export function neighbourOf(tabs: TabDescriptor[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return null
  const next = tabs[index + 1] ?? tabs[index - 1]
  return next?.id ?? null
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'restored':
      return { tabs: action.tabs, activeId: action.activeId }

    case 'opened': {
      if (state.tabs.some((tab) => tab.id === action.tab.id)) return state
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id }
    }

    case 'activated': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state
      return { ...state, activeId: action.id }
    }

    case 'removed': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state
      const activeId =
        state.activeId === action.id ? neighbourOf(state.tabs, action.id) : state.activeId
      return { tabs: state.tabs.filter((tab) => tab.id !== action.id), activeId }
    }
  }
}
