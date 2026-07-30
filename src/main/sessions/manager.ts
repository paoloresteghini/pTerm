import type { TmuxAdapter } from '../tmux/adapter'
import { PtySession } from '../pty/session'
import { decodeSessionName, encodeSessionName, newSessionId } from '../tmux/names'

export interface TabRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
}

export interface OpenInput {
  projectSlug: string
  cwd: string
  command?: string
  /** Supply to reattach an existing tab; omit to create a new one. */
  id?: string
  cols?: number
  rows?: number
}

interface Entry {
  record: TabRecord
  session: PtySession
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export class SessionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly dataListeners = new Set<(id: string, data: string) => void>()
  private readonly exitListeners = new Set<(id: string, code: number) => void>()

  constructor(private readonly adapter: TmuxAdapter) {}

  open(input: OpenInput): TabRecord {
    const id = input.id ?? newSessionId()
    if (this.entries.has(id)) throw new Error(`session ${id} is already open`)

    const record: TabRecord = {
      id,
      projectSlug: input.projectSlug,
      cwd: input.cwd,
      command: input.command,
      tmuxSession: encodeSessionName({ projectSlug: input.projectSlug, id }),
    }

    const session = new PtySession(this.adapter, {
      tmuxSession: record.tmuxSession,
      cwd: record.cwd,
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      command: record.command,
    })

    session.onData((data) => {
      for (const listener of this.dataListeners) listener(id, data)
    })
    session.onExit((code) => {
      this.entries.delete(id)
      for (const listener of this.exitListeners) listener(id, code)
    })

    this.entries.set(id, { record, session })
    session.start()
    return record
  }

  get(id: string): TabRecord | undefined {
    return this.entries.get(id)?.record
  }

  list(): TabRecord[] {
    return [...this.entries.values()].map((entry) => entry.record)
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.session.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.entries.get(id)?.session.resize(cols, rows)
  }

  /** Detach the client. The tmux session keeps running. */
  detach(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.session.detach()
  }

  detachAll(): void {
    for (const id of [...this.entries.keys()]) this.detach(id)
  }

  /** Destroy the tmux session and everything running in it. */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    const tmuxSession = entry?.record.tmuxSession ?? undefined
    if (entry) {
      this.entries.delete(id)
      entry.session.detach()
    }
    if (tmuxSession) await this.adapter.killSession(tmuxSession)
  }

  /**
   * prcli-owned tmux sessions with no client in this app — left behind by a
   * previous run or a crash. Callers decide whether to reopen them.
   */
  async findOrphans(): Promise<TabRecord[]> {
    const open = new Set(this.list().map((record) => record.tmuxSession))
    const names = await this.adapter.listPrcliSessions()
    const orphans: TabRecord[] = []
    for (const name of names) {
      if (open.has(name)) continue
      const parts = decodeSessionName(name)
      if (!parts) continue
      orphans.push({
        id: parts.id,
        projectSlug: parts.projectSlug,
        // The session already has its own working directory; reattaching
        // does not change it, so any valid path serves here.
        cwd: process.env.HOME ?? '/',
        tmuxSession: name,
      })
    }
    return orphans
  }

  onData(listener: (id: string, data: string) => void): void {
    this.dataListeners.add(listener)
  }

  onExit(listener: (id: string, code: number) => void): void {
    this.exitListeners.add(listener)
  }
}
