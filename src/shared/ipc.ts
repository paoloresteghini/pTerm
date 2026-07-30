export const CHANNELS = {
  open: 'prcli:open',
  list: 'prcli:list',
  input: 'prcli:input',
  resize: 'prcli:resize',
  detach: 'prcli:detach',
  kill: 'prcli:kill',
  restore: 'prcli:restore',
  setActive: 'prcli:setActive',
  data: 'prcli:data',
  exit: 'prcli:exit',
} as const

export interface TabDescriptor {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
}

export interface OpenRequest {
  projectSlug: string
  cwd: string
  command?: string
  id?: string
  cols?: number
  rows?: number
}

export interface DataEvent {
  id: string
  data: string
}

export interface ExitEvent {
  id: string
  code: number
}

export interface RestoreResult {
  tabs: TabDescriptor[]
  activeTabId: string | null
}

export interface PrcliApi {
  open(request: OpenRequest): Promise<TabDescriptor>
  list(): Promise<TabDescriptor[]>
  /** Reattach tabs persisted by the previous run; returns what came back. */
  restore(): Promise<RestoreResult>
  setActive(id: string | null): void
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  detach(id: string): void
  kill(id: string): Promise<void>
  onData(listener: (event: DataEvent) => void): () => void
  onExit(listener: (event: ExitEvent) => void): () => void
}
