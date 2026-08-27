import type { ReactNode } from 'react'

interface WorkspaceContextCardProps {
  utilities: ReactNode
}

/**
 * The optional panels for the light workspace. It sits beside the terminal
 * only when there is a panel to show, so the canvas owns the extra space when
 * every panel is hidden.
 */
export function WorkspaceContextCard({ utilities }: WorkspaceContextCardProps) {
  return (
    <aside
      data-testid="workspace-context"
      className="workspace-context w-60 shrink-0 self-start text-[12px] text-fg"
    >
      <div data-testid="workspace-utilities" className="flex max-h-[calc(100vh-92px)] flex-col gap-2 overflow-y-auto">
        {utilities}
      </div>
    </aside>
  )
}
