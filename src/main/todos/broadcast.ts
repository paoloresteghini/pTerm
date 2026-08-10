import { CHANNELS, type TodoRecord } from '../../shared/ipc'

/**
 * The part of a `BrowserWindow` this push needs, and nothing more.
 *
 * Structural rather than the Electron class so the rule is unit-testable at
 * all: `tests/unit` runs in a node environment where a real window cannot be
 * constructed, and the thing worth pinning is which windows get the payload
 * and which are skipped.
 */
export interface TodoBroadcastTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: TodoRecord[]): void }
}

/**
 * Hand the new list to every live window, the originator included.
 *
 * Sent to every window rather than every window but the caller's, because the
 * list is global rather than scoped to one window. This app is single-window
 * by construction, so today the only recipient is the caller itself, and it
 * has already applied the identical reply from its own mutation call: the
 * push has no observable effect right now. Sending to all windows is still
 * the rule that is correct if that ever changes. A destroyed window is
 * skipped because `webContents.send` throws on one.
 */
export function broadcastTodos(windows: TodoBroadcastTarget[], todos: TodoRecord[]): void {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.todosChanged, todos)
  }
}
