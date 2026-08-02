import { dialog, ipcMain, type BrowserWindow } from 'electron'
import {
  CHANNELS,
  type Candidate,
  type DataEvent,
  type ExitEvent,
  type NotificationConfig,
  type OpenRequest,
  type Preset,
  type ProjectDescriptor,
  type RestartRequest,
  type RestoreResult,
  type SplitRequest,
  type StatusEvent,
  type TabDescriptor,
  type TabRow,
  type TabShape,
} from '../../shared/ipc'
import type { ExitReason, SessionManager, PaneRecord } from '../sessions/manager'
import { ConfigStore, type PrcliConfig } from '../state/store'
import { StatusRegistry } from '../status/registry'
import {
  describeProjects,
  restoreWorkspace,
  tabRowFor,
  withUnsorted,
} from './restore'
import { sharesAroundClaims, tombstonesOf, type Claim } from './shares'
import { isDirectory } from '../fsutil'
import { scanCandidates } from '../projects/discovery'
import { hookPaths, installHooks, readHooksState, uninstallHooks } from '../hooks/install'
import { drainSpool } from '../hooks/spool'
import {
  addProject,
  projectForSlug,
  removeProject,
  reorderProjects,
  updateProject,
} from '../projects/projects'

/**
 * The new pane's ratio, carved out of the pane it split from.
 *
 * `sourcePaneId` keeps half its own share and `newPaneId` takes the other
 * half. Every OTHER kid the saved row already knew about keeps the share
 * that row had for it, relative to the other kids that row knew — that part
 * genuinely is untouched, and does not need a normalisation to make it true.
 * Its ABSOLUTE width is a different claim and a weaker one; the paragraphs
 * below say exactly when it moves and why that is not this carve failing.
 *
 * The part that is easy to miss is `siblings`, not `savedKids`: `siblings`
 * is the saved row's kids UNIONED with any live pane that row does not
 * mention — an "unclaimed" sibling, which today means exactly one thing: a
 * pane that died and was restarted, whose row entry `forgetTab` dropped at
 * its death and nothing has put back (`shareOf`'s `at === -1` branch, below,
 * is where that is felt). Such a pane comes with a share only when main
 * REMEMBERS the one it died at — `remembered`, which is `register.ts`'s
 * `tombstones`. Then that share is a `claim` on the whole tab and every
 * saved-derived share scales into what is left, so nothing is invented and
 * the pane comes back the size it was.
 *
 * Remembered is not guaranteed, though: the map is process-lifetime, so a
 * pane adopted from a previous run, or one whose entry a dismiss dropped,
 * arrives here unclaimed and unremembered. It is then handed a SYNTHETIC
 * share — an even split of the axis — landed on top of shares that, for the
 * OTHER kids, already summed to 1, and `sharesAroundClaims` normalises the
 * lot. That dilution moves every OTHER kid's share too — including a pane
 * the user did not touch at all, which sounds like the very thing this carve
 * exists to prevent.
 *
 * It is not, and the distinction is the point: what a carve preserves is not
 * the ABSOLUTE width of an untouched pane — it cannot, once a pane with no
 * accounted-for share is back in the room, somebody has to make space for it
 * — but the RELATIVE proportion among the kids whose shares were already
 * known. Two panes at a saved 0.6:0.4 stay at 0.6:0.4 relative to each other
 * once an unclaimed sibling dilutes both by the same factor, because the
 * dilution is a single scalar applied to every known share alike, and that
 * scalar cancels out of a ratio taken between two known kids. `sum ≈ 1`
 * cannot tell a correct dilution from an unclaimed sibling that was ignored
 * outright — the normalisation forces the sum to 1 either way.
 *
 * Neither, for the same reason, can the relative-proportion check above: two
 * known kids' ratio to each other is the SAME whether the unclaimed
 * sibling's share was computed correctly, computed wrong, or dropped to zero
 * — the common total the ratio divides through by cancels regardless of what
 * put it there. Proving the unclaimed sibling was actually accounted for
 * needs a THIRD kind of check: that pane's own final share is positive. Both
 * checks are real and both are necessary; neither is sufficient alone. Both
 * are in `tests/unit/carveRatio.test.ts`'s "dilutes every known share evenly
 * ..." test, which also carries the A/B that found this — the
 * relative-proportion assertion alone did not fail when the unclaimed
 * sibling's share was zeroed, which is the reason the third check exists.
 *
 * This overturns plan 2b's even split, whose stated reason was that "ratios
 * are the one thing the user can drag straight back" — drag did not exist
 * then, and recoverable is not the same as not destroyed. 2b's objection to
 * carving was that repeated splits hand each new pane a sliver of a sliver;
 * that is answered by the floor, which makes `splitActive` refuse such a
 * split before it is sent.
 *
 * The `remembered` half of that is Paolo's ruling, and it lands on `shareOf`'s
 * `at === -1` branch — the fallback is made correct, not removed, which is why
 * the unremembered paragraph above still describes real behaviour. With a
 * remembered kid in play the vector returned sums to 1 by construction rather
 * than by a rescale: `sharesAroundClaims` divides the bases among themselves
 * and scales them into `1 - held`. Not in every case, though — when the claims
 * themselves reach 1 that function falls back to normalising the lot, and
 * there the normalisation is load-bearing again. Whether `forgetTab`'s own
 * arithmetic keeps one tab's claims strictly below 1 is not proved anywhere in
 * this file — see `claimForDeath`'s own doc for where that induction breaks,
 * at the step where a share is exactly 1, the sole survivor of its row dying.
 * The guard is what makes this function safe regardless, without depending on
 * that bound.
 *
 * Exported and pure — no `store`, no `manager`, nothing captured from
 * `registerIpc`'s closure — so the case above can be pinned in
 * `tests/unit/carveRatio.test.ts` without a real tmux session anywhere near
 * it, the way the integration test that exercises the real "which sibling is
 * unclaimed" detection cannot afford to for every case.
 */
export function carveRatio(params: {
  kids: string[]
  sourcePaneId: string
  newPaneId: string
  siblings: string[]
  savedKids: string[]
  savedRatio: number[]
  /**
   * The share a pane held when it died, as a fraction of the whole tab, by
   * pane id. Only ever consulted for a sibling the saved row does not know —
   * which, per the paragraphs above, is exactly a pane that died and was
   * restarted. Only `share` is read; `register.ts`'s `tombstones` carries
   * a tab id on the same entry, which is that map's own business.
   */
  remembered?: ReadonlyMap<string, { share: number }>
}): number[] {
  const { kids, sourcePaneId, newPaneId, siblings, savedKids, savedRatio, remembered } = params
  const sourceAt = siblings.indexOf(sourcePaneId)
  // A `base` is a share relative to the other saved-derived shares; a `claim`
  // is a share of the whole tab. `sharesAroundClaims` is what makes the
  // difference count — see its doc comment for the ruling and for why, with no
  // claim in play, it is arithmetically the rescale this used to do inline.
  const shareOf = (id: string): { claim?: number; base: number } => {
    const at = savedKids.indexOf(id)
    if (at !== -1) return { base: savedRatio[at] ?? 1 / siblings.length }
    const claim = remembered?.get(id)?.share
    return claim === undefined ? { base: 1 / siblings.length } : { claim, base: claim }
  }
  const source = sourceAt === -1 ? { base: 1 / kids.length } : shareOf(sourcePaneId)
  // The halving carries the claim with it rather than demoting both halves to
  // bases. Splitting a restarted pane divides the share IT is remembered at
  // between it and the pane carved out of it — which is what a carve means —
  // and leaves the panes the user did not touch scaling into the rest. Demoted
  // instead, the two halves would be renormalised against the saved kids and
  // the pair would come out narrower than the one pane it replaced, which is
  // the same collapse this task exists to stop, one split later.
  const halved = {
    claim: source.claim === undefined ? undefined : source.claim / 2,
    base: source.base / 2,
  }
  return sharesAroundClaims(
    kids.map((kid) => (kid === newPaneId || kid === sourcePaneId ? halved : shareOf(kid))),
  )
}

/**
 * What a pane's death is worth, as a fraction of the WHOLE tab — never of
 * what the row already reads it as, which after any earlier death in the same
 * tab is smaller than the pane's true share. Exported and pure, mirroring
 * `carveRatio` and `sharesAroundClaims` — this file's established shape for
 * main-side arithmetic that has no business needing a real tmux session to
 * test, and the reason this was pulled out of `forgetTab`'s closure.
 *
 * `store.read()` rescales every ratio by its own total on the way in, and a
 * dead pane's kid entry is dropped on the way in too — so after one death the
 * row describes the tab AS IF that pane does not exist, and its shares are
 * fractions of `1 - that pane's claim`, not of the whole tab. Measured, three
 * panes at 0.5/0.3/0.2: kill the 0.2 and the row reads 0.625/0.375, so the
 * pane that truly holds 0.3 of the tab would be recorded at 0.375 and come
 * back a quarter wider than it died, out of panes the user never touched.
 * Silent, too — the vector still sums to 1.
 *
 * Scaling by the room the other claims have already taken converts back:
 * 0.375 x (1 - 0.2) = 0.3, exactly what it died at. A claim is defined as a
 * fraction of the whole tab (see `sharesAroundClaims`), and this is what
 * makes the recorded value one — for a SECOND death, once the first one's
 * claim is still unspent. The two-death case is what `taken` exists for.
 *
 * **`taken` here and `sharesAroundClaims`'s `held` now read the same
 * PREDICATE — `tombstonesOf` — but not yet the same INPUT, and closing that
 * remaining gap is not this task.** Both ask which claims recorded for a tab
 * are unspent, given a row: `taken` asks it of `kids`, the row as it stood the
 * instant this pane died, so a pane that is STILL a tombstone counts, because
 * nothing has rebuilt the row since it died. `held`, over in
 * `sharesAroundClaims`, only ever sees the claims `carveRatio`/`tabRowFor`
 * actually hand it — the claims of panes that are LIVE siblings at the moment
 * a split or a close rebuilds the row, because neither row builder calls
 * `tombstonesOf` itself. A pane that is still dead when the row rebuilds is
 * not a live sibling, so its claim is never offered to `sharesAroundClaims` as
 * an entry at all. Concrete case: tab A/B/C dies in order B then C, B never
 * restarted, C restarted before the next split. This function correctly
 * discounts B's claim out of C's (see the two-death test in
 * `claimForDeath.test.ts`) — but the row a later split rebuilds has no entry
 * for B whatsoever, because B is not live, so the room `sharesAroundClaims`
 * divides among A/C/the new pane never has B's share held back from it. The
 * renderer, independently, reserves B's tombstone share a second time in
 * `withKeptPanes` — see `restore.ts`'s comment above `sharesAroundClaims` for
 * the traced case where that visibly moves a pane nobody touched. Sharing the
 * predicate is what this task does, so the two readers cannot drift into
 * disagreeing about WHICH claims are unspent; making `carveRatio`/`tabRowFor`
 * actually call it for a tombstone — closing the gap itself — is Task 3 of
 * this plan, "Both row builders emit in the live-remainder frame", landing
 * two commits from here, not a third revision of this arithmetic squeezed
 * into this one.
 *
 * `!kids.includes` skips a claim that has been SPENT: once a split or a close
 * has written a restarted pane back into the row, the row accounts for it
 * again and `sharesAroundClaims` never reads its claim.
 *
 * Guarded, but not because the arithmetic proves the guard can never fire —
 * that argument does not hold. Each claim is `share x (1 - taken)` with
 * `share <= 1`; after `n` claims the cumulative total is
 * `1 - product(1 - share_i)`, which reaches exactly 1, not merely approaches
 * it, the moment any single `share_i` is exactly 1 — the sole survivor of its
 * row dying. What actually keeps a LATER read safe is not this function: it
 * is `sharesAroundClaims`'s own `room > 0` guard, which falls back to
 * renormalising the lot whenever the claims it is handed already reach 1, so
 * every share it returns stays positive and the row it builds still sums to
 * 1. The `room <= 0` branch below is the same fallback, for the same reason:
 * there is no whole tab left to take a fraction of, so recording the row's
 * own share is the honest answer.
 */
export function claimForDeath(params: {
  /** The dying pane's own share, as the row it died in describes it. */
  share: number
  /** The tab id `share` was recorded against — `row.id` at the call site. */
  tabId: string
  /** The row's current kids, so a spent claim is excluded from `taken`. */
  kids: string[]
  /** Every claim recorded so far, across every tab. */
  tombstones: ReadonlyMap<string, Claim>
}): number {
  const { share, tabId, kids, tombstones } = params
  // The same reader the row builders use, so "what this death must be
  // discounted by" and "what a rebuilt row does not account for" cannot drift
  // into two predicates again. See `tombstonesOf`.
  const taken = tombstonesOf(tabId, kids, tombstones).reduce((sum, entry) => sum + entry.share, 0)
  const room = 1 - taken
  return room > 0 ? share * room : share
}

export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  registry: StatusRegistry,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
  // Told rather than asked: `register.ts` is constructed by `index.ts`, and an
  // import back the other way to reach `setAttendedTab` directly would be a
  // cycle. A no-op default keeps every existing caller — and every test —
  // working unchanged.
  onActiveTabChanged: (id: string | null) => void = () => undefined,
  // Same reasoning as `onActiveTabChanged`: `NotificationRouter` lives in
  // `index.ts`, and this is only ever called after a spool replay (silent by
  // design — see `CHANNELS.restore` below) so the dock badge does not sit
  // stale until some unrelated tab's next transition happens to refresh it.
  refreshBadge: () => void = () => undefined,
): void {
  // The saved pane list means "reattach these next launch", which is not the
  // same set as "clients attached right now" — a detached pane must stay in it.
  // So every mutation reads, edits and rewrites rather than dumping the
  // manager's registry. The file is tiny; serialising the edits is enough to
  // keep concurrent read-modify-writes from losing one another.
  //
  // Existence lives in `config.panes` and layout in `config.tabs`, and the two
  // are not interchangeable: since v5 a tab row is an axis and its ratios and
  // holds none of the fields a session is reattached from. A handler that
  // reaches for the wrong one type-checks perfectly — a `TabRow` has an `id`
  // too — which is why that is written down here rather than left to be
  // noticed. Every handler that only opens or forgets a pane therefore works in
  // `config.panes` alone. Two below do not: `splitPane` and `closePane` change
  // what a tab HOLDS, and write both arrays in one `store.write` so no reader
  // ever sees a pane no tab lists or a kid naming no pane. `CHANNELS.restore`
  // is the third writer of `config.tabs` and the one that is easy to miss —
  // it does not write the file itself, it hands `serialise` to
  // `restoreWorkspace`, which rebuilds every row from live tmux and writes them
  // with the panes inside this same queue.
  let tail: Promise<unknown> = Promise.resolve()
  const serialise = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => undefined)
    return result
  }

  const rememberTab = (tab: TabDescriptor): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      const panes = config.panes.filter((saved) => saved.id !== tab.id)
      panes.push(tab)
      await store.write({ ...config, panes })
    })

  const forgetTab = (id: string): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      // Captured here, before the row goes and inside this same pass, so there
      // is no window in which the share is gone but unrecorded — and no second
      // read, since this one is already open. The kid is still in the row at
      // this moment: `normaliseLayout` drops a kid only once its pane row has
      // gone, and this pane's row is still in the config that was just read —
      // the `filter` below is what takes it out.
      const row = config.tabs.find((candidate) => candidate.layout.kids.includes(id))
      const at = row ? row.layout.kids.indexOf(id) : -1
      const share = row && at !== -1 ? row.layout.ratio[at] : undefined
      if (row && share !== undefined) {
        // `claimForDeath` owns the taken/room/claim arithmetic — see its own
        // doc for what `taken` actually is, the known gap between it and
        // `sharesAroundClaims`'s `held`, and why the `room <= 0` fallback is
        // not provable unreachable by induction.
        //
        // This call excludes `id`'s own entry from an earlier death — which
        // the `set` below is about to replace — without a `paneId !== id` of
        // its own: `row` was FOUND by `row.layout.kids.includes(id)`, so `id`
        // is always a member of `kids` here, and `claimForDeath`'s own
        // `!kids.includes` skips it for free. A second condition here would
        // read like a guard and never decide anything.
        const claim = claimForDeath({ share, tabId: row.id, kids: row.layout.kids, tombstones })
        // Positive, always — `normaliseLayout` refuses any share that is not,
        // and `sharesAroundClaims` reads a claim of 0 as a claim, not as an
        // absence, which would be a 0%-wide box. Asserted here, at the only
        // writer, rather than defended for a second time at the reader.
        if (claim > 0) tombstones.set(id, { tabId: row.id, share: claim })
      }
      // The pane row, not the tab row. Removing the tab row instead would
      // leave the pane on disk for good — and would type-check, because a
      // `TabRow` has an `id` too. Any layout entry left pointing at this pane
      // is collected by the next `read()`; see `normaliseLayout`.
      const panes = config.panes.filter((saved) => saved.id !== id)
      if (panes.length === config.panes.length) return
      await store.write({ ...config, panes })
    })

  /**
   * `tabs` with the row for `tabId` replaced by `next`, or dropped when `next`
   * is null.
   *
   * Keyed by `TabRow.id` — the tab's permanent identity, and the id every
   * caller here holds, since that is what `SessionManager` records per pane.
   * Never by `groupId`: a re-founding changes which group a tab is in and
   * changes nothing about which row is that tab's, and this is the helper the
   * new group id is written through.
   *
   * Both callers rewrite exactly one row and must leave every other one
   * untouched, and a tab whose last pane has closed has to lose its row rather
   * than keep an empty one — `store.read()` would drop such a row on the way
   * back in anyway, but only after it had been written, which is precisely
   * where an assertion could no longer see it.
   *
   * Replaced in place, never removed-and-appended: array order is the order the
   * tab bar draws, so splitting a pane in the third tab must not move that tab
   * to the end. A row that is not there yet is appended, which is the ordinary
   * case for the first split of a tab opened this run — `CHANNELS.open` writes
   * a pane row and no tab row.
   *
   * Free of `serialise`, `store` and the manager on purpose: the caller is
   * already inside one pass holding one `config`, and this only rearranges what
   * it holds.
   */
  const withTabRow = (tabs: TabRow[], tabId: string, next: TabRow | null): TabRow[] => {
    const at = tabs.findIndex((row) => row.id === tabId)
    if (at === -1) return next ? [...tabs, next] : tabs
    if (!next) return tabs.filter((_, index) => index !== at)
    return tabs.map((row, index) => (index === at ? next : row))
  }

  /** This tab's panes, in the order its row lays them out. */
  const held = (panes: PaneRecord[], kids: string[]): PaneRecord[] => {
    const byId = new Map(panes.map((pane) => [pane.id, pane]))
    // Filtered rather than mapped: both callers build `kids` from ids that are
    // in `panes` by construction, so nothing is dropped here today — but a
    // `map` would answer a future mismatch with an `undefined` in the array
    // that type-checks as a `PaneRecord` and reaches the renderer as one.
    return kids.flatMap((kid) => {
      const pane = byId.get(kid)
      return pane ? [pane] : []
    })
  }

  // Keyed to the three channels this file actually pushes unprompted, rather
  // than left as `(channel: string, payload: unknown)`: `unknown` is exactly
  // what let `CHANNELS.exit`'s payload go out missing `reason` for as long as
  // it did — `tsc` has no payload shape to check an omission against. A
  // per-channel map turns dropping a field back into a compile error.
  type SentPayloads = {
    [CHANNELS.data]: DataEvent
    [CHANNELS.exit]: ExitEvent
    [CHANNELS.statusChanged]: StatusEvent
  }

  const send = <C extends keyof SentPayloads>(channel: C, payload: SentPayloads[C]): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  // `SessionManager.kill()` detaches the local client — which fires the exit
  // event below — before it even knows whether `TmuxAdapter.killSession()`
  // will succeed, and killing the local client is quicker than spawning tmux
  // to destroy the session. So the exit event routinely arrives while the
  // kill is still in flight, and asking tmux fresh at that moment mostly asks
  // a question that hasn't been answered yet: a kill that would go on to
  // succeed can just as well be caught still looking alive. Recording the
  // in-flight kill here lets the exit event wait on the one query that
  // actually settles the question, instead of racing a second one against it.
  const pendingKills = new Map<string, Promise<void>>()

  // The size each tab's client last reported.
  //
  // Restart is a new attach path, and every new attach path in this codebase
  // has shipped with the same defect: attach at the 80×24 default and tmux,
  // seeing its only client, resizes the window down and SIGWINCHes whatever is
  // inside — permanently reflowing the user's scrollback. The manager keeps
  // geometry on its `Entry`, but the entry is deleted when the session dies,
  // which is precisely when Restart needs it. So it is remembered here too.
  const lastGeometry = new Map<string, { cols: number; rows: number }>()

  /**
   * The share each pane held when it died, as a fraction of the WHOLE tab,
   * with the tab it died in — and is still owed, until a rebuild spends it.
   *
   * The tab id is not bookkeeping: it is what makes the share a whole-tab
   * fraction in the first place. See `forgetTab`, which is the only writer.
   *
   * The third map of a shape that is already here twice — `lastGeometry`
   * above is process-lifetime, keyed by pane id, written at death, read at
   * restart, and dropped by the same two handlers; this inherits that
   * contract rather than inventing one, which is also why it is not
   * persisted: restore prunes dead panes at launch, so a saved share would
   * never have a pane to apply to. `SessionManager.tabWasIn` is the other
   * half of this same concept — see `shares.ts`'s `Claim`, which is where
   * that pairing is written down.
   *
   * One difference, stated rather than glossed: the other two are read by the
   * restart itself, and this one is not read until main next REBUILDS the
   * tab's row — a split or a close, which may be minutes later or never.
   *
   * The renderer keeps a tombstone's share on screen by itself (see
   * `withKeptPanes`), so this is not what the user is looking at. It is what
   * main needs the moment it rebuilds the tab's row — at which point the
   * restarted pane is a kid the saved row never knew, and the even fallback
   * would flatten a ratio that survived both the death and the restart.
   *
   * Never consulted for a kid the saved row DOES know: once a split or a close
   * has written the restarted pane back into the row, the row is the authority
   * again and this entry is simply never read. That is why nothing deletes it
   * at restart — a stale entry cannot outvote a live row, and deleting it there
   * would break the contract the two maps above keep.
   */
  const tombstones = new Map<string, Claim>()

  registry.onTransition(({ tabId, to }) => {
    const payload: StatusEvent = { tabId, state: to }
    send(CHANNELS.statusChanged, payload)
  })

  ipcMain.handle(CHANNELS.status, () => registry.snapshot())

  /**
   * Whether the tmux session outlived the client that just stopped.
   *
   * `detached` is how a session survives on purpose, so that one answers
   * itself. `killed` is answered by the kill already in flight for it, via
   * `pendingKills`, when there is one to ask. `exited` — and a `killed` with
   * no pending kill on record, which should not happen but must still get a
   * real answer rather than an assumed one — asks tmux directly.
   */
  const sessionSurvived = async (record: PaneRecord, reason: ExitReason): Promise<boolean> => {
    if (reason === 'detached') return true
    const pending = reason === 'killed' ? pendingKills.get(record.id) : undefined
    if (pending) {
      // `manager.kill()` resolving means `killSession()` succeeded: dead.
      // `killSession()` only throws once it has verified the session is
      // still there (or the verification itself failed, which the shared
      // catch below already treats as "alive" — the safe default).
      try {
        await pending
        return false
      } catch {
        return true
      }
    }
    try {
      return await manager.hasSession(record.tmuxSession)
    } catch {
      // Could not find out. Answering "alive" keeps a stale row and a stale
      // tab, which costs a line of config and a click; answering "dead" for a
      // live session loses it.
      return true
    }
  }

  manager.onData((id, data) => send(CHANNELS.data, { id, data }))
  manager.onExit((record, code, reason) => {
    // The renderer needs the answer to travel with the event: it draws the
    // tabs, and a tab whose session is still running must stay in the bar.
    // That makes the send wait on the kill (or on tmux) in the `killed` and
    // `exited` cases — a genuine death still reaches the renderer, one round
    // trip later.
    void (async () => {
      const sessionAlive = await sessionSurvived(record, reason)
      send(CHANNELS.exit, { id: record.id, code, sessionAlive, reason })
      if (!sessionAlive) {
        // Stamped ahead of `forgetTab` below, and carrying `record` with it.
        // `forgetTab` deletes the saved config row, and by the time a
        // listener as far away as the notification router tries to
        // rediscover this tab from its id alone, both the live manager entry
        // (already gone — `manager.ts` deleted it before this callback even
        // ran) and the saved row can be gone too, resolving to nothing and
        // leaving `crashed`/`ended` the only two states that could never
        // toast. Passing `record` sidesteps that race outright rather than
        // betting on read/write ordering across two independent config-file
        // operations. `killed` is exempted for the same reason it always
        // was: the CHANNELS.closePane handler below calls `registry.forget`
        // once its own await on the very same `manager.kill()` promise
        // settles, and recording a tombstone here too would race that forget
        // with no ordering guarantee — whichever runs last wins, and a losing
        // `forget` would leak a `crashed`/`ended` entry nothing would ever
        // clean up. A kill the user asked for does not need a tombstone —
        // they already know it is gone.
        if (reason !== 'killed') registry.applyExit(record.id, code, record)
        // `killed` is never pruned here either, for the same reason: the
        // CHANNELS.closePane handler already owns that, and drops the pane's
        // config row inside the same pass that rewrites its tab, once the
        // `manager.kill()` this resolved against has succeeded — pruning here
        // too would only be a redundant second write of the same outcome.
        if (reason === 'exited') await forgetTab(record.id)
      }
    })()
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    // node-pty does not throw on a missing cwd — it yields a live process that
    // produces nothing, so the tab renders permanently blank while its tmux
    // session is perfectly fine. Say what is actually wrong instead.
    if (!(await isDirectory(request.cwd))) {
      throw new Error(`Cannot open a terminal: ${request.cwd} is not a directory`)
    }
    const record = manager.open(request)
    await rememberTab(record)
    registry.applyOpen(record.id, record.type)
    return record
  })

  ipcMain.handle(CHANNELS.list, (): TabDescriptor[] => manager.list())

  // The reconcile reads and then writes, so it has to hold the queue for the
  // whole operation rather than racing an `open` or an exit between the two.
  ipcMain.handle(CHANNELS.restore, async (): Promise<RestoreResult> => {
    const result = await restoreWorkspace(manager, store, serialise)
    // restoreWorkspace reattaches every tab through `manager.open` directly,
    // never through the CHANNELS.open handler above — so nothing else ever
    // gives a restored tab an initial state. Left alone, a relaunched
    // `claude` tab would show no dot at all rather than the hollow `unknown`
    // one deserves, indistinguishable from a shell nothing has run in.
    //
    // Restore is also how a mid-session renderer reload (⌘R) re-fetches the
    // workspace, and by then the registry already knows real states from
    // hook events main never stopped receiving. Only a tab the registry has
    // never seen gets initialised here — that is what keeps ⌘R from
    // stamping a live `waiting`/`thinking` tab back to `unknown`.
    //
    // Per pane, not per tab row: status is tracked by tab id, which since v5
    // is a pane's own id (a group's founder id for a split tab, but every
    // pane still has one), and `result.tabs` holds layout — axis and ratios —
    // not the ids this loop needs.
    for (const pane of result.panes) {
      if (registry.get(pane.id) === null) registry.applyOpen(pane.id, pane.type)
    }

    // Whatever the hook script spooled while nothing was listening — a
    // socket write that failed because the app was down. Run only now,
    // after the reconcile above has decided which tabs actually survived:
    // an event for a tab tmux no longer has must not resurrect a dot for a
    // session that is gone. A second `restore` in one run (⌘R) costs
    // nothing extra — the spool file drainSpool already took is gone.
    //
    // Applied silently: replaying describes a past, and routing each one to
    // the notification router the way a live transition is would toast the
    // whole weekend back at the user in a tight loop the moment the app
    // opens. `refreshBadge` below still catches the badge up in one shot
    // once the final state is in, rather than leaving it stale until some
    // unrelated tab's next live transition happens to correct it.
    //
    // Per pane again: a spooled hook message names the pane's own
    // `PRCLI_TAB_ID`, never a tab row's group id.
    const live = new Set(result.panes.map((pane) => pane.id))
    const spooled = await drainSpool(hookPaths().spool, Date.now())
    for (const message of spooled) {
      if (!live.has(message.tabId)) continue
      // A spooled death is never replayed. A tab that died while the app was
      // down has no session left, so reconcile has already pruned its row and
      // the membership check above drops the line anyway — which makes this
      // branch unreachable in every case that can actually happen, and the
      // only cases it *could* reach are ones where replaying would be wrong:
      // an id reopened since would be painted red for a life that already
      // ended, and `applyDead`'s verdict would then outrank how the new one
      // really ends. Silence is the same answer in the reachable case and the
      // safe one in the rest.
      if (message.event === 'Exit') continue
      registry.applyHook(message, { silent: true })
    }
    refreshBadge()

    // Folded into the same response rather than left for the renderer's own,
    // separate `status()` call: that call raced this whole reconcile — which
    // takes seconds at twelve tabs — with no ordering guarantee, and the
    // renderer's `restored` case resets `status` to `{}`, so the direction
    // that loses blanks the board at every launch. One response has nothing
    // left to race against.
    return { ...result, status: registry.snapshot() }
  })

  /**
   * The project list a mutation answers with — Unsorted included.
   *
   * Restore is the only other place that builds this, and it builds it the same
   * way, so a mutation and a relaunch cannot disagree. Skipping the Unsorted row
   * here would mean a removed project's still-running sessions dropped off the
   * screen until the next launch, which is the opposite of leaving them alive
   * and reachable.
   *
   * The pane set is config's, not the manager's. A detached tab stays in the tab
   * bar — its session is running and only its client is gone — so describing
   * against live clients alone would drop the Unsorted row such a tab needs.
   * Every caller below runs inside the write queue, where config's pane list is a
   * superset of the manager's: an `open` records its pane through the same queue
   * before anything else can read it.
   *
   * Panes, because `describeProjects` resolves each project's `activeTabId`
   * against the rows it is given and has always been given pane rows — see the
   * ambiguity recorded on `ProjectRecord.activeTabId`.
   */
  const described = async (config: PrcliConfig): Promise<ProjectDescriptor[]> =>
    withUnsorted(await describeProjects(config.projects, config.panes), config.panes)

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    // Read directly, never through `serialise`: the queue has no reentrancy
    // protection, and this callback is what the router's `isAttended` reads
    // on every transition. Anything downstream of it calling back into
    // `serialise` would deadlock the queue silently.
    onActiveTabChanged(id)
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      // A pane row: this writes the id back to `ProjectRecord.activeTabId`,
      // which `describeProjects` resolves against pane rows. v5 leaves that
      // pairing exactly as it was rather than moving one end of it — see the
      // ambiguity recorded on `ProjectRecord.activeTabId`.
      const tab = config.panes.find((saved) => saved.id === id)
      if (!tab) return
      const owner = projectForSlug(config, tab.projectSlug)
      // A tab under Unsorted has no row to record this on, by design.
      if (!owner) return
      await store.write({
        ...config,
        projects: config.projects.map((project) =>
          project.id === owner.id ? { ...project, activeTabId: id } : project,
        ),
      })
    })
  })

  ipcMain.on(CHANNELS.setActiveProject, (_event, id: string | null) => {
    void serialise(async () => {
      const config = await store.read()
      await store.write({ ...config, activeProjectId: id })
    })
  })

  /**
   * Write a dragged ratio down, once, when the pointer comes up.
   *
   * `ipcMain.on`, not `handle`: the renderer already has the layout on
   * screen — it dispatched `resized` into `state.tabs` on every frame of the
   * gesture, and `paneGroups` has been drawing from that the whole time. This
   * handler exists only so the NEXT launch agrees, so there is nothing here
   * worth a round trip or a rejection the caller would have to do anything
   * with. A failed write costs a ratio, not a session.
   *
   * Sent once, on release, by `App.tsx`'s `commitLayout` — never per frame.
   * `state.tabs` is where a gesture's ratios live while it runs precisely so
   * that no push path from the renderer to here exists during a drag; adding
   * one now would put several writes a second through a queue this same file
   * shares with restore and the exit handler.
   *
   * A row for a tab this handler has no saved layout for is not invented: a
   * missing `saved` means either a tab younger than this run's last read (its
   * row comes from `CHANNELS.splitPane`, not from here) or one `store.read()`
   * has already dropped for naming no live pane in its kids. Guessing a row
   * into existence from a ratio alone would be inventing membership, which is
   * exactly the thing `withTabRow` exists to never do implicitly.
   *
   * The length guard's dominant trigger is NOT a race, and saying so overstates
   * how rarely this fires. A race is real but rare: a ratio captured at
   * `grabPane` describes the row as it stood at pointerdown, and a split or a
   * close landing mid-drag changes `kids` under it before this handler runs —
   * that costs one gesture, once.
   *
   * The common case is structural. Any tab holding a tombstone, or a pane that
   * died and was restarted but has not yet been rebuilt into a saved row by a
   * split or a close, has a renderer-side `layout.kids` that is a PERMANENT
   * strict superset of `saved.layout.kids` on disk: `forgetTab` drops the dead
   * pane's row entry and `normaliseLayout` then drops its kid, but the
   * renderer's reducer never removes a dead kid from `state.tabs` on its own
   * (`died` only writes `state.dead`; `removeTab` filters `state.panes` and
   * leaves `kids` alone). Every ratio this handler is sent for such a tab
   * fails the length check, every single time, for as long as the tab holds
   * that pane — which can be indefinitely, since only a split or a close
   * rebuilds the row and closes the gap.
   *
   * Silent in both cases, and the consequence is the same either way: the
   * drag is not persisted. The user sees the dragged ratio on screen — that
   * came from the reducer dispatching `resized`, not from disk — but the
   * write to `config.tabs` is dropped here, so the next launch reverts to the
   * ratio before the drag, and so does the next split or close: both rebuild
   * the row from `saved.layout.ratio`, i.e. from whatever this handler last
   * actually managed to write, as if the drag had never happened.
   *
   * Writes `config.tabs` and nothing else. Layout, never existence: a ratio
   * has no business touching `config.panes`, and the "leaves the panes alone"
   * test exists to catch a handler that reaches for it anyway.
   */
  ipcMain.on(CHANNELS.setLayout, (_event, tabId: string, ratio: number[]) => {
    void serialise(async () => {
      const config = await store.read()
      const saved = config.tabs.find((row) => row.id === tabId)
      if (!saved) return
      if (ratio.length !== saved.layout.kids.length) return
      const tabs = withTabRow(config.tabs, tabId, {
        ...saved,
        layout: { ...saved.layout, ratio },
      })
      await store.write({ ...config, tabs })
    })
  })

  ipcMain.handle(CHANNELS.addProject, (_event, input: { name: string; cwd: string }) =>
    serialise(async () => {
      const { config } = addProject(await store.read(), input)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(
    CHANNELS.updateProject,
    (_event, id: string, patch: { name?: string; presets?: Preset[] }) =>
      serialise(async () => {
        const config = updateProject(await store.read(), id, patch)
        await store.write(config)
        return described(config)
      }),
  )

  ipcMain.handle(CHANNELS.removeProject, (_event, id: string) =>
    serialise(async () => {
      // The project's sessions keep running. They stop matching a project and
      // surface under Unsorted, so nothing is stranded and nothing is killed.
      const config = removeProject(await store.read(), id)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.reorderProjects, (_event, ids: string[]) =>
    serialise(async () => {
      const config = reorderProjects(await store.read(), ids)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.scanCandidates, async (): Promise<Candidate[]> => {
    const config = await store.read()
    return scanCandidates(config.projects.map((project) => project.cwd))
  })

  ipcMain.handle(CHANNELS.pickFolder, async (): Promise<string | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.moveTabToProject, (_event, tabId: string, projectId: string) =>
    serialise(async () => {
      const config = await store.read()
      const target = config.projects.find((project) => project.id === projectId)
      if (!target) throw new Error(`moveTabToProject: no project ${projectId}`)

      // Every pane of the tab, or none of them. A pane's project membership
      // lives in its own member session name, so moving the founder alone
      // would leave the tab split across two projects; `moveTabToProject`
      // renames every member and rolls the lot back if any rename is refused.
      //
      // The saved rows go along because a pane whose client has gone is
      // resolved through tmux, which synthesises a cwd and knows no command at
      // all; config holds the real ones. The map is keyed by pane id over the
      // whole of `config.panes` rather than over this tab's rows alone: the
      // callee looks up only the panes it actually moves, so the other entries
      // cost a lookup that never happens, and narrowing it by the tab's layout
      // row would drop the truth for a pane whose row is on disk but whose tab
      // row — layout only, and dropped by `read()` whenever it stops
      // describing panes that exist — is not.
      const known = new Map<string, Pick<PaneRecord, 'cwd' | 'command' | 'type'>>(
        config.panes.map((row) => [
          row.id,
          { cwd: row.cwd, command: row.command, type: row.type },
        ]),
      )
      const moved = await manager.moveTabToProject(tabId, target.slug, known)

      // Replace in place where config already lists a pane, so the tab bar
      // keeps its order; append the ones it does not list. A plain `map` would
      // quietly drop the record for a pane config had never written — the
      // invariant that restore always writes one first holds on every path
      // this milestone exercises, but it is an invariant, not a guarantee, and
      // the cost of it failing is a session running under a name nothing on
      // disk knows. This invents nothing: the renames above succeeded, so the
      // sessions are there.
      //
      // The tab's own row is deliberately untouched: it carries layout, and a
      // move changes no pane id, no axis and no ratio.
      const byId = new Map<string, PaneRecord>(moved.map((pane) => [pane.id, pane]))
      const listed = new Set(config.panes.map((row) => row.id))
      const panes = [
        ...config.panes.map((row) => byId.get(row.id) ?? row),
        ...moved.filter((pane) => !listed.has(pane.id)),
      ]
      const updated: PrcliConfig = { ...config, panes }
      await store.write(updated)
      return { projects: await described(updated), panes: moved }
    }),
  )

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) => {
    // Same guard the manager applies, so a rejected size is never remembered
    // as the one a restart should attach at.
    if (cols >= 1 && rows >= 1) lastGeometry.set(id, { cols, rows })
    manager.resize(id, cols, rows)
  })

  // No persistence here: detaching is how a session survives, so forgetting it
  // would be exactly the wrong thing to record.
  ipcMain.on(CHANNELS.detach, (_event, id: string) => manager.detach(id))

  ipcMain.handle(
    CHANNELS.restartTab,
    async (_event, request: RestartRequest): Promise<TabDescriptor> => {
      const { tab } = request
      // Same guard `open` applies: node-pty does not throw on a missing cwd,
      // it yields a live process that produces nothing, so the tab comes back
      // permanently blank while looking fine.
      if (!(await isDirectory(tab.cwd))) {
        throw new Error(`Cannot restart: ${tab.cwd} is not a directory`)
      }
      const remembered = lastGeometry.get(tab.id)
      // `reopenInTab`, not `open`: a pane of a split has to REJOIN its tab's
      // group, and a bare `new-session -A` would bring it back beside the tab
      // instead of in it (finding I4). The manager decides which of the three
      // cases this is — see `reopenInTab`; only the "still has live siblings"
      // one does anything `open` did not.
      //
      // Nothing here says which tab the pane was in, and nothing in the
      // request could: the manager recorded that when the pane was created or
      // adopted. See `SessionManager.tabWasIn` and `RestartRequest`.
      const { record, groupId } = await manager.reopenInTab({
        id: tab.id,
        projectSlug: tab.projectSlug,
        cwd: tab.cwd,
        command: tab.command,
        type: tab.type,
        // The renderer's live measurement first, the last one main saw
        // second. Attaching at neither would let tmux shrink the recreated
        // session to 80×24 — the defect this codebase has now shipped twice.
        cols: request.cols ?? remembered?.cols,
        rows: request.rows ?? remembered?.rows,
      })

      // Which tab this pane came back into. It and `groupId` differ exactly
      // when the tab had no live member left and has re-founded around this
      // pane or an earlier one back: tmux cannot name a group after a session
      // it no longer has, so the group takes the name of whichever pane
      // returned first, while the tab keeps the id it has always had.
      //
      // The group comes back FROM the reopen rather than being asked of tmux
      // after it, and that is not a shortcut: the reopen is what decided it,
      // and on the re-founding path the session it just spawned may not have
      // reached tmux yet — a `list-sessions` in this line reads that as "the
      // tab has no group" and leaves the row pointing at a group that is gone.
      const tabId = manager.tabIdOf(record.id) ?? record.id

      // `rememberTab` would write the pane row and nothing else, and it is a
      // `serialise` wrapper, so the row update could not join it — two passes,
      // with a window in between where the file says this tab is in a group it
      // is not. One pass writes both.
      await serialise(async () => {
        const config = await store.read()
        const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]
        const saved = config.tabs.find((row) => row.id === tabId)
        // Only when there is a row to correct. A tab that died WHOLE has none
        // by now — `forgetTab` dropped each pane row as its pane died, and
        // `store.read()` drops a tab row whose kids have all gone — so nothing
        // is written for it here, and nothing should be: a row naming panes
        // that do not exist is the one thing `normaliseLayout`'s "config
        // supplies layout, never existence" rule forbids. The tab's identity
        // is carried by the manager until the next split or close writes a row
        // under it.
        const tabs =
          saved && saved.groupId !== groupId
            ? withTabRow(config.tabs, tabId, { ...saved, groupId })
            : config.tabs
        await store.write({ ...config, panes, tabs })
      })
      registry.applyOpen(record.id, record.type)
      return record
    },
  )

  ipcMain.on(CHANNELS.dismissTab, (_event, id: string) => {
    // The row is already gone from config — the exit handler forgot it. This
    // drops the state, so the dock badge stops counting a tab nobody can see.
    registry.forget(id)
    lastGeometry.delete(id)
    tombstones.delete(id)
    // Dismissing the tombstone is what takes Restart off the screen, so the
    // tab id kept for it goes the same way its geometry does — and so does the
    // share it died at, which only a restart could ever have spent.
    manager.forgetPane(id)
  })

  ipcMain.handle(CHANNELS.splitPane, async (_event, request: SplitRequest): Promise<TabShape> => {
    const { paneId, dir, cols, rows } = request
    // Refused, not defaulted. `splitTab` falls back to 80×24 and then resizes
    // the new window to whatever it settled on, unconditionally — `open()`'s
    // "no size given means do not size the window" guard does not reach it — so
    // an unmeasured split drives a window to the default rather than leaving it
    // to follow its client. Same shape of test as `CHANNELS.resize`'s guard,
    // and written as `>=` rather than `<` so a `NaN` from a renderer that
    // measured a hidden element is refused too.
    if (!(cols >= 1 && rows >= 1)) {
      throw new Error(`Cannot split: pane ${paneId} was not measured (got ${cols}x${rows})`)
    }

    // Outside every `serialise` pass, like `CHANNELS.closePane`'s `manager.kill`:
    // the tmux work first, then one pass of our own. Doing it the other way
    // round would be worse than slow — `serialise` is `tail.then(op, op)` with
    // no reentrancy protection, so anything it reaches that calls back into it
    // waits on its own caller for good.
    const record = await manager.splitTab({ paneId, cols, rows })

    // Read off the NEW pane, after the split, rather than derived a second time
    // from the sibling: this is the id `splitTab` itself decided and recorded
    // for the member it just made, so the row written below cannot be named
    // something the manager disagrees with.
    //
    // The sibling is asked second, and the sibling's own id only third. Nothing
    // can actually reach past the first — `tabIdOf` is the next synchronous
    // statement after the `await` above resolves, and the pty exit callback
    // that disposes an entry is a macrotask, which cannot interleave inside a
    // microtask continuation. But the last fallback is wrong wherever it is
    // reached: `paneId` is the SIBLING's id, and that equals the tab id only
    // when the sibling is the founder. Split from any other pane and it names a
    // tab nothing matches, which loses the layout at the next restore — the
    // failure `tabIdOf`'s own doc warns about. Asking the sibling's entry first
    // costs nothing and is right in both directions.
    const tabId = manager.tabIdOf(record.id) ?? manager.tabIdOf(paneId) ?? paneId
    // The group that tab is in now, which is its own id unless it has
    // re-founded since its panes all died. Asked here rather than taken from
    // the saved row: after a re-founding there IS no saved row, and the row
    // this handler is about to write is the first thing to record the tab's
    // new group. Outside the pass below, like every other tmux call here.
    const groupId = await manager.groupIdOf(tabId)

    // The same initialisation `CHANNELS.open` does, and needed for the same
    // reason: nothing else gives a pane its first state, so a `claude` pane
    // split off a tab would otherwise show no dot at all until its first hook.
    registry.applyOpen(record.id, record.type)

    return serialise(async () => {
      const config = await store.read()
      const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]

      // `store.read()` has already dropped every kid that named a pane not in
      // `config.panes`, so the saved kids all still exist and none needs
      // filtering here. No saved row at all means a tab that has never been
      // split: `CHANNELS.open` writes none and restore writes one for every tab
      // it brings back, so the sibling alone is the best starting point.
      const saved = config.tabs.find((row) => row.id === tabId)
      const savedKids = saved?.layout.kids ?? [paneId]
      // Unioned with the tab's other live panes, because the row alone is not
      // the whole tab: a pane that died and was restarted is running, back in
      // this group, and back in `config.panes`, but no row claims it — its row
      // entry went when it died and nothing puts it back until the next
      // restore. Building `kids` from the row alone would drop a LIVE pane from
      // both the file and the reply, which is the one thing `TabShape` promises
      // not to do. Appending it is also exactly what `restore.ts`'s `tabRowFor`
      // does with a pane its saved row never knew, so this writes the row the
      // next restore would have produced rather than inventing a policy.
      //
      // `manager.panesOfTab` rather than the manager's own entries: it starts
      // from live tmux, so it also sees a pane whose session survives with no
      // client attached — detached, and still a member of this tab. Only the
      // ids are read, so the cwd it synthesises for a pane it has no entry for
      // never reaches anything.
      //
      // Filtered against `panes` because a kid has to name a pane row: an id
      // that names none would be dropped by the next `store.read()` anyway, and
      // `held` below would answer for it with nothing.
      const listed = new Set(panes.map((pane) => pane.id))
      const unclaimed = (await manager.panesOfTab(tabId))
        .map((pane) => pane.id)
        .filter((id) => id !== record.id && !savedKids.includes(id) && listed.has(id))
      const siblings = [...savedKids, ...unclaimed]
      const at = siblings.indexOf(paneId)
      const kids =
        at === -1
          ? [...siblings, record.id]
          : [...siblings.slice(0, at + 1), record.id, ...siblings.slice(at + 1)]

      const row: TabRow = {
        // The TAB's id, never the new pane's — a pane added to a tab is not
        // its founder, and a row named after it would be a second tab in the
        // bar with the first one's panes in it.
        id: tabId,
        // And the group it is in now, which is what the next restore resolves
        // this row by: that is all live tmux can report about a tab.
        groupId,
        // The pane the user just asked for is the one they are looking at.
        activePaneId: record.id,
        layout: {
          // A tab's axis is set by the split that CREATES it, and a later
          // split adds a pane along that axis instead of re-orienting the tab.
          //
          // A RULING, not something the one-axis-per-tab rule forces — three
          // answers are consistent with that rule and this is the chosen one,
          // so it is written down rather than left to be re-derived. Applying
          // the request every time was the other behaviour this had: it makes
          // the axis always reflect the last split asked for, but the cost
          // lands on panes the user did not touch, and with terminals a
          // re-orientation is not cosmetic — every pane reflows and its real
          // tmux session is resized. Refusing the split outright was the third,
          // rejected as a dead key with no explanation. Ignoring is the only
          // one that adds the pane the user asked for without moving panes
          // they did not act on.
          //
          // Gated on the tab actually being split, not merely on a row
          // existing. Restore writes a row for every tab it brings back,
          // one-pane tabs included, so keying off `saved` alone would make
          // ⇧⌘D silently do ⌘D on any tab relaunched since it was opened — the
          // dead-key failure the ruling exists to avoid, reached from the other
          // side. A tab of one pane has no axis on screen to preserve.
          dir: saved && siblings.length > 1 ? saved.layout.dir : dir,
          // See `carveRatio`'s own doc comment for what this does and does
          // not preserve — in particular, for the "dilutes every known share
          // evenly" case an unclaimed sibling produces, which is not a bug.
          ratio: carveRatio({
            kids,
            sourcePaneId: paneId,
            newPaneId: record.id,
            siblings,
            savedKids,
            savedRatio: saved?.layout.ratio ?? [],
            // What an unclaimed sibling is owed, when main saw it die. The
            // same map `closePane` hands `tabRowFor`, so the two rebuilds of a
            // tab's row agree about what a remembered share means.
            remembered: tombstones,
          }),
          kids,
        },
      }

      // Both arrays in one write. `rememberTab` is deliberately not used: it is
      // itself a `serialise` wrapper and would deadlock inside this pass, and
      // it writes `config.panes` alone — a separate write for the tab row would
      // leave a window in which the file holds a pane no tab lists.
      const tabs = withTabRow(config.tabs, tabId, row)
      await store.write({ ...config, panes, tabs })
      return { panes: held(panes, kids), tabs: [row] }
    })
  })

  /**
   * The one way a pane is closed.
   *
   * There used to be two: a `CHANNELS.kill` that destroyed the session and
   * forgot the pane, and this, which does all of that AND maintains the tab
   * row the pane was laid out in. Two channels differing only in whether the
   * layout is kept is a place for drift — whichever one ⌘W did not use would
   * leave a stale row the first time it met a split tab — so the narrower one
   * is gone and every caller comes here.
   */
  ipcMain.handle(CHANNELS.closePane, async (_event, paneId: string): Promise<TabShape> => {
    // Before the kill, and it has to be: `manager.kill()` deletes the entry
    // this is held on, and a dead pane's tab is not recoverable afterwards —
    // its membership lived in the tmux session the kill destroys. The fallback
    // is a pane this process never held, which is a tab of one by definition.
    const tabId = manager.tabIdOf(paneId) ?? paneId

    // Recorded before the first await inside `manager.kill()` can run, so it
    // is always in place before the exit event it settles could possibly fire:
    // that event is answered by asking this map, and it fires while the kill
    // is still in flight. See `pendingKills`.
    const outcome = manager.kill(paneId)
    pendingKills.set(paneId, outcome)
    try {
      await outcome
    } finally {
      pendingKills.delete(paneId)
    }
    // A killed pane is not restartable, so its state, the geometry a restart
    // would have attached at, the share a restart would have come back at and
    // the tab a restart would have rejoined all go together. See
    // `SessionManager.forgetPane`.
    registry.forget(paneId)
    lastGeometry.delete(paneId)
    tombstones.delete(paneId)
    manager.forgetPane(paneId)

    // After the kill, so it reads the group the tab is left in rather than the
    // one it was in with this pane still alive — and outside the pass below,
    // like the kill itself.
    const groupId = await manager.groupIdOf(tabId)

    return serialise(async () => {
      const config = await store.read()
      const panes = config.panes.filter((saved) => saved.id !== paneId)

      // The same union `splitPane` builds, and for the same reason: a pane that
      // died and was restarted is live and in `config.panes` but in no row, and
      // closing its sibling must not be the thing that drops it from the tab.
      // The pane just closed cannot come back through it — `manager.kill()`
      // destroyed its tmux session, which is what `panesOfTab` reads, and
      // `listed` is the survivors on disk.
      const saved = config.tabs.find((row) => row.id === tabId)
      const savedKids = saved?.layout.kids ?? []
      const listed = new Set(panes.map((pane) => pane.id))
      const unclaimed = (await manager.panesOfTab(tabId))
        .map((pane) => pane.id)
        .filter((id) => !savedKids.includes(id) && listed.has(id))
      const kids = [...savedKids.filter((kid) => kid !== paneId), ...unclaimed]

      // `restore.ts`'s `tabRowFor`, on the same inputs and for the same reason:
      // a kid the saved row knew keeps its own share, a kid it does not know
      // but that `tombstones` remembers claims the share it died at, and
      // anything else takes an even one — with the saved-derived shares scaled
      // into whatever the claims leave, so the row describes a whole tab.
      // This handler had its own copy of that, converged on it line for line —
      // and the rescale is exactly the part that can rot unnoticed in one copy,
      // since `store.read()` rescales again on the way back in and repairs the
      // evidence.
      //
      // `tombstones` is passed here and nowhere in `restoreWorkspace`,
      // which is why the parameter is optional: restore prunes dead panes at
      // launch, so it never has a restarted pane to apply one to.
      //
      // A tab with no panes left loses its row outright rather than keeping an
      // empty one, which would put a tab nobody can see in the bar until the
      // next read swept it. That is why the emptiness is tested here rather
      // than inside `tabRowFor`, whose other caller can never be handed none.
      const row: TabRow | null =
        kids.length > 0 ? tabRowFor({ id: tabId, groupId }, kids, saved, tombstones) : null

      const tabs = withTabRow(config.tabs, tabId, row)
      await store.write({ ...config, panes, tabs })
      return { panes: row ? held(panes, row.layout.kids) : [], tabs: row ? [row] : [] }
    })
  })

  ipcMain.handle(CHANNELS.notifications, async () => (await store.read()).notifications)

  ipcMain.handle(
    CHANNELS.updateNotifications,
    (_event, patch: Partial<NotificationConfig>): Promise<NotificationConfig> =>
      serialise(async () => {
        const config = await store.read()
        const notifications = { ...config.notifications, ...patch }
        await store.write({ ...config, notifications })
        return notifications
      }),
  )

  // installHooks/uninstallHooks write ~/.claude/settings.json, not PRCLI's own
  // config file, so these deliberately do not go through `serialise` above.
  // That queue has no reentrancy protection, and nothing reached from inside
  // it may call back into it — going through it here would risk a silent
  // deadlock for a screen the user is looking straight at.
  ipcMain.handle(CHANNELS.hooksState, () => readHooksState())
  ipcMain.handle(CHANNELS.installHooks, () => installHooks())
  ipcMain.handle(CHANNELS.uninstallHooks, () => uninstallHooks())
}
