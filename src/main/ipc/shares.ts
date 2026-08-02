/**
 * What one tab owes one pane its row does not name, as a fraction of the WHOLE
 * tab.
 *
 * Recorded at a pane's death by `register.ts`'s `forgetTab`, through
 * `claimForDeath`, and dropped by the two handlers that end a pane's
 * restartability — `dismissTab` and `closePane`. The tab id is not
 * bookkeeping: it is what makes the share a whole-tab fraction rather than a
 * fraction of a row, and it is what `tombstonesOf` and `claimFor` both filter
 * on.
 *
 * `SessionManager.tabWasIn` is the other half of this same concept — a
 * process-lifetime map, keyed by pane id, written at death, read at restart,
 * dropped by the same two handlers, recording WHICH TAB the dead pane was in
 * while this records WHAT IT HELD. Two maps in two files recording facts about
 * the same dead pane is one concept whether or not it is one map; it is not
 * moved here because the manager is where a pane's membership is decided, but
 * a change to the lifetime of either belongs in both.
 */
export interface Claim {
  readonly tabId: string
  readonly share: number
}

/**
 * The share `tabId` owes `paneId`, or undefined when it owes it nothing.
 *
 * Filtered on the tab, not merely looked up by pane id. Pane ids are unique
 * today, so the filter decides nothing — but a claim is defined as a fraction
 * of one named tab, and reading one against a different tab would be reading a
 * number in a frame it was never measured in. Stated as a filter so the
 * definition is enforced rather than relied upon.
 */
export function claimFor(
  tabId: string,
  paneId: string,
  claims: ReadonlyMap<string, Claim>,
): number | undefined {
  const held = claims.get(paneId)
  return held && held.tabId === tabId ? held.share : undefined
}

/**
 * Which panes of `tabId` are tombstones right now: every claim recorded for
 * that tab whose pane `kids` does not name.
 *
 * **This is `claimForDeath`'s `taken` predicate, unchanged, evaluated at a
 * different moment**, and that is the whole of what this design adds to main.
 * At a death, `kids` is the row as it stands and the answer is what the dying
 * pane's share has to be discounted by. At a rebuild, `kids` is the row about
 * to be written and the answer is what that row does not account for — the
 * panes the renderer is still drawing and main has forgotten. The two were
 * previously described in `claimForDeath`'s doc as "NOT the same set, and that
 * is a known, open gap"; they are now one set, read twice.
 *
 * A claim whose pane IS in `kids` is spent: the row accounts for that pane
 * again, so nothing is owed outside it. That is a restarted pane the moment a
 * split or a close writes it back in.
 */
export function tombstonesOf(
  tabId: string,
  kids: readonly string[],
  claims: ReadonlyMap<string, Claim>,
): { id: string; share: number }[] {
  return [...claims].flatMap(([id, held]) =>
    held.tabId === tabId && !kids.includes(id) ? [{ id, share: held.share }] : [],
  )
}

/**
 * Shares for one row's kids, where a `claim` is a share of the WHOLE tab and a
 * `base` is a share of whatever that leaves.
 *
 * Every kid whose share is derived from the saved row supplies a `base`; those
 * bases are meaningful only relative to one another, so they are normalised
 * among themselves and then scaled into `room` — what the claims do not take.
 * A kid with a `claim` gets that claim untouched. The vector therefore sums to
 * 1 by construction rather than by a rescale bolted on to cover a gap.
 *
 * A claim is what a remembered share is, on Paolo's ruling: a pane that died
 * at 0.3 of its tab comes back at 0.3 of its tab, not at 0.3 of a row that has
 * already claimed the whole of it. Injecting the remembered share alongside
 * the saved-derived ones and renormalising the lot was the other candidate and
 * it does not deliver that — measured, a pane that died at 0.3 came back at
 * 0.231. "The user can drag it back" is the argument this plan's Ruling 2
 * already rejected for the split path; it is no better here.
 *
 * **The renderer's own rule for the arithmetic — and only the arithmetic.**
 * `withKeptPanes` in `src/renderer/workspace.ts` solves this exact problem
 * for a tombstone on screen, with the same `held`/`room` shape and the same
 * two guards, and given the SAME claims the two agree: a remembered share is
 * scaled in, never renormalised away. What they are not given is the same
 * claims, and that is where the two sides are known to disagree rather than
 * agree.
 *
 * This function only ever sees a claim for a pane that is a LIVE sibling at
 * the moment `carveRatio`/`tabRowFor` rebuilds the row — `register.ts`'s
 * `splitPane`/`closePane` build `siblings`/`ids` from what tmux and the saved
 * row currently show, and a pane that is still a tombstone is neither.
 * `withKeptPanes` sees a claim for every pane still in the renderer's
 * `state.dead`, live sibling or not. A pane that died and has not been
 * restarted is therefore a claim on the renderer's side and no claim at all
 * here — `register.ts`'s `claimForDeath` names this the same open gap from
 * main's side; see its doc.
 *
 * Traced, not hypothetical. Tab `A .5 / C .3 / B .2`. B dies and is never
 * restarted. C dies and IS restarted before the next split. The user splits
 * A. Main rebuilds the row over `siblings = [A, C]` — B is not live, so its
 * claim never reaches this function, and A/C/the new pane divide the WHOLE
 * tab among themselves: A 0.35, new 0.35, C 0.30 (C's claim correctly
 * recovered at exactly what it died at — the two-death case `claimForDeath`
 * gets right). The renderer, independently, still lists B in `state.dead` and
 * `withKeptPanes` reserves its 0.2 on top of that already-whole vector,
 * scaling everything else down to make room a second time: measured, C ends
 * up drawn at 0.24, not 0.30, though nobody touched it. That is the drift a
 * "not a second rule" claim would paper over — the arithmetic is one rule,
 * agreed on both sides; the INPUT to it is not, and fixing that needs a death
 * ordinal or an equivalent, which is deliberately not attempted in this wave.
 *
 * **With no claim among the entries this is arithmetically today's code.**
 * `held` is 0, `room` is 1, and every base is divided by the total of the
 * bases — which is precisely the `share / total` rescale both call sites used
 * to do inline. That is why no existing expectation moves, and it is a
 * property worth knowing rather than assuming.
 *
 * The two guard CONDITIONS are `withKeptPanes`'s, for its reasons: claims
 * summing to 1 or more leave no room, and bases summing to nothing leave
 * nothing to scale. What is done about them is not the same, and this is the
 * better half of the pair — `withKeptPanes` falls back to an even split, which
 * by its own admission resizes every tombstone, while this renormalises the
 * entries in the proportions they came in with, which preserves them. Only an
 * all-zero set, where there are no proportions to preserve, falls back to an
 * even split here. A zero share would otherwise be a 0%-wide box, which fits
 * to tmux's floor of 2x1 — the geometry defect wearing different numbers.
 *
 * A claim of exactly 0 would slip both guards and produce that 0%-wide box, so
 * it is refused at the writer instead: `normaliseLayout` returns only shares
 * greater than 0, and `register.ts`'s `forgetTab` — the only producer of a
 * claim — records nothing otherwise. Cited here rather than defended a second
 * time, because a zero claim is a caller error and there is no non-arbitrary
 * share for this function to invent in its place.
 */
export function sharesAroundClaims(
  entries: readonly { claim?: number; base: number }[],
): number[] {
  const held = entries.reduce((sum, entry) => sum + (entry.claim ?? 0), 0)
  const room = 1 - held
  const bases = entries.reduce((sum, entry) => sum + (entry.claim === undefined ? entry.base : 0), 0)
  if (room > 0 && bases > 0) {
    return entries.map((entry) => entry.claim ?? (entry.base / bases) * room)
  }
  const shares = entries.map((entry) => entry.claim ?? entry.base)
  const total = held + bases
  return total > 0 ? shares.map((share) => share / total) : entries.map(() => 1 / entries.length)
}
