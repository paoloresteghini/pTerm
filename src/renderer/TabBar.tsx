import type { TabDescriptor } from '../shared/ipc'
import { cn } from './lib/cn'

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
  canOpen,
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
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
            <span>{label(tab)}</span>
            <button
              data-testid={`close-${tab.id}`}
              aria-label={`Close ${label(tab)}`}
              onClick={(event) => {
                // Without this the click also activates the tab being closed.
                event.stopPropagation()
                onClose(tab.id)
              }}
              className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-inherit"
            >
              ×
            </button>
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
