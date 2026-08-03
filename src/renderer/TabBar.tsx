import type { TabDescriptor, TabState } from '../shared/ipc'
import { StatusDot } from './StatusDot'
import { cn } from './lib/cn'
import { labelOfPane } from './workspace'

export function TabBar({
  tabs,
  activeId,
  status,
  dead,
  onActivate,
  onClose,
  onRestart,
  onDismiss,
  onNew,
  canOpen,
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  status: Record<string, TabState>
  dead: Record<string, number>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onRestart: (tab: TabDescriptor) => void
  onDismiss: (id: string) => void
  onNew: () => void
  canOpen: boolean
}) {
  return (
    <div
      data-testid="tabbar"
      className="flex h-8 select-none items-stretch overflow-x-auto border-b border-border bg-surface font-mono text-[11px]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => onActivate(tab.id)}
            className={cn(
              'flex cursor-default items-center gap-1.5 whitespace-nowrap border-r border-border px-2.5',
              active ? 'bg-bg text-fg shadow-[inset_0_-1px_0_var(--color-accent)]' : 'text-muted',
            )}
          >
            <StatusDot state={status[tab.id] ?? null} testid={`dot-${tab.id}`} />
            <span className={cn(dead[tab.id] !== undefined && 'line-through opacity-60')}>
              {labelOfPane(tab)}
            </span>
            {dead[tab.id] !== undefined ? (
              <>
                {/* A dead tab keeps its scrollback and offers the two things
                    worth doing with it. Restart recreates the session under
                    the same id, cwd, command and type. */}
                <button
                  data-testid={`restart-${tab.id}`}
                  aria-label={`Restart ${labelOfPane(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRestart(tab)
                  }}
                  className="cursor-default border-none bg-transparent p-0 text-[10px] text-muted hover:text-fg"
                >
                  ↻
                </button>
                <button
                  data-testid={`dismiss-${tab.id}`}
                  aria-label={`Dismiss ${labelOfPane(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDismiss(tab.id)
                  }}
                  className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-muted hover:text-fg"
                >
                  ×
                </button>
              </>
            ) : (
              // The close button stays exactly as it was for a live tab —
              // closing kills, and killing a dead session has nothing to do.
              <button
                data-testid={`close-${tab.id}`}
                aria-label={`Close ${labelOfPane(tab)}`}
                onClick={(event) => {
                  // Without this the click also activates the tab being closed.
                  event.stopPropagation()
                  onClose(tab.id)
                }}
                className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-inherit"
              >
                ×
              </button>
            )}
          </div>
        )
      })}
      <button
        data-testid="new-tab"
        aria-label="New terminal"
        onClick={onNew}
        disabled={!canOpen}
        className="cursor-default border-none bg-transparent px-3 text-sm text-faint disabled:opacity-40 enabled:hover:text-muted"
      >
        +
      </button>
    </div>
  )
}
