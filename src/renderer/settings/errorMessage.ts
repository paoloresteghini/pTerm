/**
 * The message to show for a rejected IPC call. Every section that talks to
 * the main process uses it: three keep their own error state and show this
 * in a dedicated slot, and UpdatesSection folds it into the same
 * updateResult it would otherwise show on success, so it lives beside them
 * rather than inside any one of them.
 */
export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
