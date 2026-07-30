import type { CSSProperties } from 'react'
import type { TabDescriptor } from '../shared/ipc'

const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  height: 32,
  background: '#0c0c0e',
  borderBottom: '1px solid #27272a',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  userSelect: 'none',
  overflowX: 'auto',
}

function tabStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 10px',
    borderRight: '1px solid #27272a',
    color: active ? '#fafafa' : '#71717a',
    background: active ? '#09090b' : 'transparent',
    boxShadow: active ? 'inset 0 -1px 0 #a3e635' : undefined,
    whiteSpace: 'nowrap',
    cursor: 'default',
  }
}

/** The tmux id is 16 hex characters; the first six are plenty to tell tabs apart. */
function label(tab: TabDescriptor): string {
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}) {
  return (
    <div style={BAR} data-testid="tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid={`tab-${tab.id}`}
          data-active={tab.id === activeId ? 'true' : 'false'}
          style={tabStyle(tab.id === activeId)}
          onClick={() => onActivate(tab.id)}
        >
          <span>{label(tab)}</span>
          <button
            data-testid={`close-${tab.id}`}
            aria-label={`Close ${label(tab)}`}
            onClick={(event) => {
              // Without this the click also activates the tab being closed.
              event.stopPropagation()
              onClose(tab.id)
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'default',
              fontSize: 12,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        data-testid="new-tab"
        aria-label="New terminal"
        onClick={onNew}
        style={{
          background: 'none',
          border: 'none',
          color: '#3f3f46',
          cursor: 'default',
          fontSize: 14,
          padding: '0 12px',
        }}
      >
        +
      </button>
    </div>
  )
}
