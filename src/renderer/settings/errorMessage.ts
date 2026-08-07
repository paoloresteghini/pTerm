/**
 * The message to show for a rejected IPC call. Three sections need it and
 * each keeps its own error state, so it lives beside them rather than inside
 * any one of them.
 */
export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
