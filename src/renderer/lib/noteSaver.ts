/**
 * Debounced per-project note writes.
 *
 * The pending record carries the project id captured at edit time, which is
 * the whole point: `flush` on a project switch writes the OLD project's text
 * under the OLD project's id, never the one the panel is switching to. An
 * edit arriving under a different id than the pending one flushes the old
 * record first rather than dropping it.
 */
export interface NoteSaver {
  edit(projectId: string, text: string): void
  flush(): void
}

export function createNoteSaver(
  write: (projectId: string, text: string) => void,
  delayMs = 500,
): NoteSaver {
  let pending: { projectId: string; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending === null) return
    const { projectId, text } = pending
    pending = null
    write(projectId, text)
  }

  return {
    edit(projectId, text) {
      if (pending !== null && pending.projectId !== projectId) flush()
      pending = { projectId, text }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    flush,
  }
}
