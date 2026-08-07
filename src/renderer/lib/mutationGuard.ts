/**
 * Guards a `busy` flag against a mutation that outlives the project it was
 * sent to.
 *
 * Before this existed, `busy` was cleared only from inside a mutation's own
 * `.finally()`, gated on "is this reply still for the project I asked
 * about". Switching the active project while a stage or unstage was in
 * flight left that gate permanently closed for that call: its `.finally()`
 * never cleared `busy`, and because nothing else ever did either, every
 * later stage/unstage button in the column stayed disabled until the app
 * restarted.
 *
 * `projectSwitched()` now clears `busy` itself, on the spot, rather than
 * leaving it to an async reply that may never usefully arrive. `started()`/
 * `isCurrent()`/`settled()` still guard the opposite failure: a switch AWAY
 * and BACK to the same project must not let a call from the earlier visit
 * apply its now-stale reply, or re-lock `busy` out from under a fresh
 * mutation the new visit may have started. Each visit gets its own
 * generation number, so a token from a visit that has ended reads as stale
 * even once the shown project id matches again.
 */
export interface MutationGuard {
  /** Whether a mutation started under the CURRENT generation is still open. */
  isBusy(): boolean
  /** Call when the shown project changes. Frees `busy` unconditionally. */
  projectSwitched(): void
  /** Call before sending a mutation. Returns the token the rest of this need. */
  started(): number
  /** Whether `token`, from `started()`, is still the live generation. */
  isCurrent(token: number): boolean
  /** Call from the mutation's `.finally()`. A stale token leaves `busy` alone. */
  settled(token: number): void
}

export function createMutationGuard(setBusy: (value: boolean) => void): MutationGuard {
  let generation = 0
  let busy = false

  return {
    isBusy: () => busy,
    projectSwitched() {
      generation += 1
      busy = false
      setBusy(false)
    },
    started() {
      busy = true
      setBusy(true)
      return generation
    },
    isCurrent: (token) => token === generation,
    settled(token) {
      if (token !== generation) return
      busy = false
      setBusy(false)
    },
  }
}
