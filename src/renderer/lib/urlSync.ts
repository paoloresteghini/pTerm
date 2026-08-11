/**
 * Debounced fire-and-forget delivery of a browser pane's navigated-to URL.
 *
 * Pulled out of `BrowserPane` so the coalescing itself is testable in plain
 * node. The pane renders a `<webview>`, and this repo has no component-test
 * infrastructure to mount one against: `vitest.config.mts` runs
 * `environment: 'node'`, with no jsdom, no happy-dom and no
 * `@testing-library/react`. A pure timer module needs none of that.
 *
 * Modelled on `noteSaver.ts`'s `createNoteSaver`, with one deliberate
 * difference: there is no `flush`. A note wants its last edit committed on a
 * project switch even mid-debounce; a pane's URL does not, because the write
 * this exists for must never fire once the pane it names is gone. `cancel`
 * drops whatever is pending instead of sending it early.
 */
export interface UrlSync {
  schedule(paneId: string, url: string): void
  cancel(): void
}

export function createUrlSync(
  send: (paneId: string, url: string) => void,
  delayMs = 500,
): UrlSync {
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    schedule(paneId, url) {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        send(paneId, url)
      }, delayMs)
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
