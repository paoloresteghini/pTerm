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
 * Sent to every window rather than every window but the caller's: the list
 * is global, so a second window holding the same todos needs the same push a
 * peer window's edit produces. A destroyed window is skipped because
 * `webContents.send` throws on one.
 */
export function broadcastTodos(windows: TodoBroadcastTarget[], todos: TodoRecord[]): void {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.todosChanged, todos)
  }
}
