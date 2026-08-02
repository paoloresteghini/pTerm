import type { TabRow } from '../../shared/ipc'

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
 * Before this task, this function only ever saw a claim for a pane that was a
 * LIVE sibling at the moment `carveRatio`/`tabRowFor` rebuilt the row —
 * `register.ts`'s `splitPane`/`closePane` built `siblings`/`ids` from what
 * tmux and the saved row currently show, and a pane that was still a
 * tombstone was neither. It now sees a claim for every unspent claim of the
 * tab, live sibling or not: both row builders call `tombstonesOf` themselves
 * before ever calling this, and append an entry for every tombstone it names
 * to the ones `kids` supplies — see `inLiveFrame`, which is what then strips
 * those appended entries back out before the row is written. `withKeptPanes`
 * sees a claim for every pane still in the renderer's `state.dead`, live
 * sibling or not, which was already true of it and remains true — the
 * paragraph above is where the two sides still differ.
 *
 * Traced, not hypothetical — and now a description of a FIXED defect, not of
 * current behaviour; kept because the numbers are the evidence for WHAT fixed
 * it, which is not this function — see below. Tab `A .5 / C .3 / B .2`. B
 * dies and is never restarted. C dies and IS restarted before the next split.
 * The user splits A. Before this task, main rebuilt the row over
 * `siblings = [A, C]` — B was not live, so its claim never reached this
 * function, and A/C/the new pane divided the WHOLE tab among themselves: A
 * 0.35, new 0.35, C 0.30 (C's claim correctly recovered at exactly what it
 * died at — the two-death case `claimForDeath` gets right — but B's claim was
 * nowhere subtracted from the room A/new split, only from C's). The renderer,
 * independently, still listed B in `state.dead`, and `withKeptPanes` reserved
 * its 0.2 out of that vector: measured, C ended up drawn at 0.24, not 0.30,
 * though nobody had touched it.
 *
 * `carveRatio`/`tabRowFor` now call `tombstonesOf` themselves and hand this
 * function B's claim alongside A/C/new's, and THAT is what fixes the screen:
 * with B's 0.2 held back from the room too, A/new's own room shrinks from 0.7
 * to 0.5 and they come back at 0.25 each rather than 0.35, while C's own
 * claim stays exactly 0.3 — the PROPORTION among A/new/C moves from 7:7:6 to
 * 5:5:6, which is the actual correction and is entirely `tombstonesOf`'s
 * doing. Measured: reverting `inLiveFrame` below and keeping only this append
 * still draws C at 0.30, byte-identical to the full fix, because
 * `withKeptPanes` divides by the incoming sum and `boxesOfRow` divides by the
 * kept total — the renderer only ever sees PROPORTIONS, and a single positive
 * scalar over every live share cannot change a proportion between two of
 * them. `inLiveFrame` is exactly that scalar: it cannot draw C at 0.30 instead
 * of 0.24, and measured, it never did. What it does is re-express A/new/C's
 * already-correct shares of the 0.8 they hold as fractions that sum to 1 —
 * 0.3125 / 0.3125 / 0.375 — the frame `config.tabs` is already in and the one
 * `normaliseLayout` would put the row into on the next read regardless (see
 * its own doc, below).
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

/**
 * A layout message's shares, split into what belongs in the row and what
 * belongs in the tombstone record.
 *
 * The renderer's shares are whole-tab and cover its whole row — every live kid
 * AND every tombstone — so they sum to 1. Main's row covers only the panes it
 * has, so the saved kids' shares are divided by their own total: the same
 * projection `inLiveFrame` does for a split, so a drag and a split cannot
 * disagree about the frame. What is left over names panes the row does not
 * have, and each one has to be a pane this tab already owes a share to.
 *
 * **All or nothing.** A message that names a pane this tab cannot place, or
 * that fails to name a saved kid, describes a tab main and the renderer
 * disagree about the membership of. Applying half of it would put the row in
 * one frame and the record in another, and pairing a short ratio with the
 * row's kids is worse still: `normaliseLayout` reads a ratio shorter than its
 * kids as unusable and flattens the whole tab to an even split, so a drag
 * would silently reset the layout it was adjusting. Refused, with a reason the
 * caller logs — and that log is the only one on this path, because this is the
 * only outcome that is not simply a drag being written down.
 *
 * Nothing here checks that the shares sum to 1. That is the channel's
 * contract, held by the renderer's own row invariant, and it is a
 * cross-process fact this side cannot verify; a tolerance check here would be
 * the length guard back in another shape. `ratio` is immune to it either way —
 * it is a projection — while `owed` is not, and that is stated rather than
 * defended.
 */
export type RoutedShares =
  | { ok: true; ratio: number[]; owed: { id: string; share: number }[] }
  | { ok: false; why: string }

export function routeShares(
  shares: Readonly<Record<string, number>>,
  savedKids: readonly string[],
  owes: (paneId: string) => boolean,
): RoutedShares {
  const missing = savedKids.filter((kid) => shares[kid] === undefined)
  if (missing.length > 0) return { ok: false, why: `no share for ${missing.join(', ')}` }
  const rest = Object.keys(shares).filter((id) => !savedKids.includes(id))
  const unplaced = rest.filter((id) => !owes(id))
  if (unplaced.length > 0) return { ok: false, why: `no pane or claim for ${unplaced.join(', ')}` }
  const mine = savedKids.map((kid) => shares[kid] ?? 0)
  const held = mine.reduce((sum, share) => sum + share, 0)
  if (!(held > 0)) return { ok: false, why: 'the saved kids hold none of the tab' }
  return {
    ok: true,
    ratio: mine.map((share) => share / held),
    owed: rest.map((id) => ({ id, share: shares[id] ?? 0 })),
  }
}

/**
 * `routeShares`, wired to one tab's saved row and its tombstone record —
 * the whole decision `CHANNELS.setLayout`'s handler exists to make, minus the
 * two impure things around it: reading `saved` off `config.tabs` and writing
 * `owed` back into the live `tombstones` map.
 *
 * That split exists for exactly one reason: `tombstones` is private to
 * `registerIpc`'s closure, and the only way anything outside this file could
 * ever put a claim in it was a real pane death — which meant the whole
 * decision this function makes, "does this drag's shares route through
 * `claimFor` and `routeShares` into the row and the claims a tab actually
 * has", had exactly one witness, and it was the most pty-expensive test in
 * the plan. Taking a `tombstones` map as a plain argument means a unit test
 * can hand it one built by hand — no death, no restart, no tmux — and watch
 * the SAME wiring `register.ts` runs decide what a drag owes a tombstone.
 * What is left over in the handler is `store.read()`, the `!saved` guard, the
 * `!ok` log, and a loop writing `owed` into the map: no decision left to get
 * wrong, only I/O.
 */
export function layoutWrite(
  saved: TabRow,
  shares: Readonly<Record<string, number>>,
  tabId: string,
  tombstones: ReadonlyMap<string, Claim>,
): { ok: true; row: TabRow; owed: { id: string; share: number }[] } | { ok: false; why: string } {
  const routed = routeShares(shares, saved.layout.kids, (id) => claimFor(tabId, id, tombstones) !== undefined)
  if (!routed.ok) return { ok: false, why: routed.why }
  return {
    ok: true,
    row: { ...saved, layout: { ...saved.layout, ratio: routed.ratio } },
    owed: routed.owed,
  }
}

/**
 * The `live` ids' shares, re-expressed as shares of what they hold between
 * them — selected out of a whole-tab vector by pane id, not by position.
 *
 * **A projection onto a smaller basis, not a renormalisation.** `whole` sums
 * to 1 by construction — `sharesAroundClaims` guarantees it — so the total
 * divided by here is exactly `1 - (what the tombstones hold)`. Both readings
 * are true and only one of them is the reason: the reason is that the row
 * being written describes the panes it names and nothing else, and the
 * tombstone total is the CHECK. Written as one division so nobody later
 * replaces it with `share / sum(share)` on the live ids alone, which agrees
 * numerically and stops being a projection the moment the vector it is given
 * does not sum to 1.
 *
 * `config.tabs` has always been in this frame: `normaliseLayout` rescales
 * every saved row over the panes that exist, and a dead pane's kid is dropped
 * on the way in — measured: a row written as `[.25, .25, .3]` (summing to
 * 0.8, the live kids' true whole-tab total) reads back as
 * `[.3125, .3125, .375]` on the next `store.read()`. This function just does
 * that conversion at write time instead of leaving it to the next read, so
 * the row on disk means what it says without waiting for a reload to fix it.
 * It does NOT fix what is drawn on screen before that reload: a single
 * positive scalar over every live share moves no proportion between them, so
 * this function has no way to change what the renderer draws, and does not —
 * see `sharesAroundClaims`'s own doc for what actually does.
 *
 * The guard is not provably unreachable and is not written as though it were,
 * for the same reason `sharesAroundClaims`'s `room > 0` note gives: the live
 * ids hold nothing only when the tombstones hold the whole tab, which
 * `sharesAroundClaims`'s own fallback makes very hard to reach and neither
 * function proves impossible. An even split is the only division that needs
 * no data, and a zero share would be a 0%-wide box, which fits to tmux's 2x1
 * floor — the geometry defect wearing different numbers.
 *
 * A prefix slice — taking `whole`'s first `live.length` entries — was
 * rejected even though both call sites build `whole` as the kids' entries
 * followed by the tombstones' entries today: that would make this function
 * depend on the tombstone entries being appended last, a contract nothing
 * states and nothing tests, in a change whose whole point is that a share
 * travels with the pane it belongs to, not with a position in an array.
 */
export function inLiveFrame(
  whole: readonly number[],
  ids: readonly string[],
  live: readonly string[],
): number[] {
  const shareOf = new Map(ids.map((id, index) => [id, whole[index] ?? 0]))
  const held = live.reduce((sum, id) => sum + (shareOf.get(id) ?? 0), 0)
  return held > 0
    ? live.map((id) => (shareOf.get(id) ?? 0) / held)
    : live.map(() => 1 / live.length)
}
