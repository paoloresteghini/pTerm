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
  /** Saved tmux name, checked against the one this input encodes to. */
  tmuxSession?: string
  cols?: number
  rows?: number
}

/**
 * Why a client stopped.
 *
 * `detached` and `killed` are the cases we caused and therefore know the
 * outcome of. `exited` is everything else — and it says nothing about whether
 * the tmux session survived. `Ctrl-b d`, `tmux detach-client` and a client
 * killed from outside all land here with the session still running. Treating
 * `exited` as "the session is gone" strands live sessions; ask the adapter.
 */
export type ExitReason = 'detached' | 'killed' | 'exited'

interface Entry {
  record: TabRecord
  session: PtySession
  /**
   * Set before we deliberately tear a client down, so the PTY's exit callback
   * can tell a detach or a kill apart from the child genuinely exiting.
   */
  intent?: 'detached' | 'killed'
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export class SessionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly dataListeners = new Set<(id: string, data: string) => void>()
  private readonly exitListeners = new Set<
    (record: TabRecord, code: number, reason: ExitReason) => void
  >()

  constructor(private readonly adapter: TmuxAdapter) {}

  open(input: OpenInput): TabRecord {
    const id = input.id ?? newSessionId()
    if (this.entries.has(id)) throw new Error(`session ${id} is already open`)

    const tmuxSession = encodeSessionName({ projectSlug: input.projectSlug, id })
    // A saved name that disagrees with what this input encodes to means the
    // record is corrupt. Attaching anyway would silently create an empty
    // session under the encoded name and strand the real one.
    if (input.tmuxSession !== undefined && input.tmuxSession !== tmuxSession) {
      throw new Error(
        `open: saved tmux session ${JSON.stringify(input.tmuxSession)} ` +
          `does not match ${JSON.stringify(tmuxSession)}`,
      )
    }

    const record: TabRecord = {
      id,
      projectSlug: input.projectSlug,
      cwd: input.cwd,
      command: input.command,
      tmuxSession,
    }

    const session = new PtySession(this.adapter, {
      tmuxSession: record.tmuxSession,
      cwd: record.cwd,
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      command: record.command,
    })

    const entry: Entry = { record, session }

    session.onData((data) => {
      for (const listener of this.dataListeners) listener(id, data)
    })
    session.onExit((code) => {
      // Compare identity, not just the id: a detached tab can be reopened
      // before its old client's exit lands, and that late event must not
      // evict the new entry.
      if (this.entries.get(id) === entry) this.entries.delete(id)
      const reason: ExitReason = entry.intent ?? 'exited'
      // The record travels with the event: by the time a listener runs the
      // entry is gone, and a listener that has to check whether the tmux
      // session survived needs its name.
      for (const listener of this.exitListeners) listener(record, code, reason)
    })

    this.entries.set(id, entry)
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
    entry.intent = 'detached'
    this.entries.delete(id)
    entry.session.detach()
  }

  detachAll(): void {
    for (const id of [...this.entries.keys()]) this.detach(id)
  }

  /**
   * Destroy the tmux session and everything running in it. Works whether or
   * not this app is attached — a tab detached earlier is still killable.
   */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      entry.intent = 'killed'
      this.entries.delete(id)
      entry.session.detach()
      await this.adapter.killSession(entry.record.tmuxSession)
      return
    }

    const orphan = (await this.findOrphans()).find((record) => record.id === id)
    // Resolving here would report success without killing anything.
    if (!orphan) throw new Error(`kill: no tmux session found for tab ${id}`)
    await this.adapter.killSession(orphan.tmuxSession)
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

  /** Whether the tmux session behind a tab is still running. */
  async hasSession(tmuxSession: string): Promise<boolean> {
    return this.adapter.hasSession(tmuxSession)
  }

  onExit(listener: (record: TabRecord, code: number, reason: ExitReason) => void): void {
    this.exitListeners.add(listener)
  }
}
