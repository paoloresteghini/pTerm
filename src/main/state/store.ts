import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PaneRecord } from '../sessions/manager'
// Declared with the other wire types: the renderer edits presets and sends them
// back, and a second structurally identical declaration here would only invite
// drift. Re-exported so existing importers keep working.
import type { NotificationConfig, Preset, TabLayout, TabRow, TabType } from '../../shared/ipc'
import { isPaneColor } from '../../shared/paneColors'
import { isThemeId, THEME_DEFAULT, type ThemeId } from '../../shared/themes'

export type { Preset, TabLayout, TabRow }

export interface ProjectRecord {
  id: string
  /** Display name. Freely renameable — the slug does not follow it. */
  name: string
  /** Immutable once allocated: it is baked into every session name. */
  slug: string
  cwd: string
  /** User-defined only. Repo presets merge in above this at read time. */
  presets: Preset[]
  /**
   * Per-project, so returning to a project lands where you left it.
   *
   * Ambiguous under v5 and deliberately left that way: it is written by
   * `setActive` from a pane id and resolved by `describeProjects` against pane
   * rows, both of which predate tabs and panes being different things. Which of
   * the two it names is a renderer-visible decision — a project could land on a
   * tab and let the tab's own `activePaneId` pick the pane inside it — so it is
   * recorded here rather than settled as a side effect of this migration.
   */
  activeTabId: string | null
  /** Same as `activeTabId`, resolved by `describeProjects` against the browser region instead. */
  activeBrowserTabId: string | null
}

export interface PTermConfig {
  version: 9
  /** Array order is sidebar order, and the order ⌘1–9 follows. */
  projects: ProjectRecord[]
  activeProjectId: string | null
  /** Every pane, flat. Which tab holds one is `tabs[].layout.kids`. */
  panes: PaneRecord[]
  /**
   * Order, selection and layout — never existence. Live tmux decides what
   * exists; orientation and drag ratios are the two things it cannot report,
   * which is the whole reason these rows are on disk.
   */
  tabs: TabRow[]
  notifications: NotificationConfig
  /** Which palette the window paints in. See `src/shared/themes.ts`. */
  theme: ThemeId
}

/**
 * Toast on, sound off.
 *
 * The parent spec names Funk for `waiting` and Glass for `idle`, but this
 * machine's ~/.claude/settings.json already runs `afplay` on Notification and
 * Stop with exactly those two sounds, so shipping them would double-fire. The
 * install screen names the collision instead, and the pickers start unset.
 */
export const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  rules: [
    { on: 'waiting', toast: true, sound: null, urgency: 'high' },
    { on: 'crashed', toast: true, sound: null, urgency: 'high' },
    { on: 'idle', toast: true, sound: null, urgency: 'low' },
  ],
  muteWhenFocused: true,
  quietHours: null,
}

const EMPTY: PTermConfig = {
  version: 9,
  projects: [],
  activeProjectId: null,
  panes: [],
  tabs: [],
  notifications: DEFAULT_NOTIFICATIONS,
  theme: THEME_DEFAULT,
}

/**
 * The one field every version has had, and the only one worth demanding: each
 * branch below already tolerates every array it reads being missing or the
 * wrong type, so refusing the whole file for a bad `tabs` would throw away
 * projects and rules that were perfectly readable.
 */
function hasVersion(value: unknown): value is { version: number } {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { version?: unknown }).version === 'number'
}

function isProject(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<ProjectRecord>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.slug === 'string' &&
    typeof p.cwd === 'string'
  )
}

/**
 * A pane row that restore can actually use.
 *
 * Validated for the same reason project rows are: `read()` promises never to
 * throw, and handing `restore.ts` a `null` it dereferences is that promise
 * broken one frame later rather than kept. A row missing only its optional
 * `type` is normalised, not dropped — a live session is worth more than a
 * correct type field.
 */
function isPane(value: unknown): value is PaneRecord {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Partial<PaneRecord>
  if (typeof t.id !== 'string') return false
  if (typeof t.projectSlug !== 'string') return false
  if (typeof t.cwd !== 'string') return false
  // Per kind, not per row. An editor, diff or browser pane has no tmux
  // session and never will, so requiring one of every row would drop it. But
  // a TERMINAL row with no session is the malformed row this function has
  // always rejected, and a blanket `typeof t.tmuxSession === 'string' ||
  // true` would lose that.
  //
  // A row with no `type` predates the field, and every version before this
  // one held terminals only, so it is a terminal here and needs a session.
  return (
    t.type === 'editor' ||
    t.type === 'diff' ||
    t.type === 'browser' ||
    typeof t.tmuxSession === 'string'
  )
}

const TAB_TYPES: readonly TabType[] = ['claude', 'preset', 'shell', 'editor', 'diff', 'browser']

function normalisePane(pane: PaneRecord): PaneRecord {
  // The one field in a pane row that grants a capability rather than
  // describing a pane, and the only one this function removes outright
  // instead of type-checking.
  //
  // `agentSessionId` (`TabDescriptor`, `shared/ipc.ts`) means "an agent may
  // drive this pane right now". Its only record is the runtime map in
  // `main/ipc/register.ts`, which is empty at every launch, and no
  // `PaneRecord` this app writes carries it. But `isPane` accepts extra
  // properties and every step below copies by spread, so before this line a
  // hand-edited row carrying the field came straight back out of `read()`,
  // and `browserPaneFor` (`main/mcp/route.ts`) routes on exactly that field.
  //
  // Which matters because of who can edit this file. The principal the
  // browser tool is scoped against is an agent with a shell, running in a
  // pane of the project this config belongs to: adding
  // `"agentSessionId": "<its own pane id>"` to the user's hand-opened browser
  // row would have made the next `browser_navigate` drive that pane, and
  // `refusesNonLoopback` would not have confined it either, since that reads
  // the runtime map rather than the row.
  //
  // Dropped here rather than at the one reader that routes on it, so that
  // every reader of a pane row gets the same answer: `read()` is the only way
  // into this process for a row on disk, so this is where "the file cannot
  // vote" is enforceable once. The row itself survives: a forged field is not
  // a reason to take the user's browser pane away.
  const { agentSessionId: _forged, ...unclaimed } = pane as PaneRecord & {
    agentSessionId?: unknown
  }
  // Before the `type` shortcut below, which returns early: a row can have a
  // good type and a bad title at the same time.
  const titled = typeof unclaimed.title === 'string' ? unclaimed : { ...unclaimed, title: undefined }
  // Validated rather than carried, and validated HERE rather than at the
  // picker. The picker can only offer the six, but a config file is a text
  // file: without this an edited `"color": "#ffffff"` reaches xterm's theme
  // and leaves a pane whose text cannot be read. Anything unrecognised reads
  // as no colour, which is the default background.
  const coloured = isPaneColor(titled.color) ? titled : { ...titled, color: undefined }
  // Beside the colour above, and for the same reason: config is a text file.
  // A row whose `filePath` is not a string keeps the row and loses the field,
  // which Task 5 draws as a pane saying the file is gone.
  const filed = typeof coloured.filePath === 'string' ? coloured : { ...coloured, filePath: undefined }
  // Beside `filePath`, and for the same reason: config is a text file. An
  // edited `"diffSide": "index"` is neither of the two real values, and reads
  // as absent, which is fine: `App.tsx` already treats an absent `diffSide`
  // as `worktree`.
  const sided =
    filed.diffSide === 'staged' || filed.diffSide === 'worktree'
      ? filed
      : { ...filed, diffSide: undefined }
  const related =
    typeof sided.diffRelPath === 'string' ? sided : { ...sided, diffRelPath: undefined }
  // Beside `diffRelPath`, and for the same reason: config is a text file. An
  // edited `"url": 42` would otherwise reach a webview's `src` attribute.
  const urled = typeof related.url === 'string' ? related : { ...related, url: undefined }
  if (TAB_TYPES.includes(urled.type)) return urled
  // A v3 row cannot say whether it was running Claude, and does not need to —
  // hooks decide that. Only the launch command is knowable from the record.
  return { ...urled, type: urled.command === undefined ? 'shell' : 'preset' }
}

/**
 * Every readable pane row, in file order, one per id. Anything else on the way
 * out.
 *
 * The dedupe is `tabRows`' rule one level down: first wins, and a later row
 * naming a pane already taken is dropped rather than merged, because there is
 * no non-arbitrary way to choose between two rows claiming to be one pane.
 *
 * Not a shape this app writes on purpose, and reachable all the same: nothing
 * between a handler's array-building and `store.write` checks for it, and a
 * hand-edited file has no checks at all. What it costs is not cosmetic.
 * `state.panes` is the list the tab bar maps over, keyed by pane id, so a
 * duplicate is two React children under one key; `paneGroups` then boxes only
 * the first, by `seen`.
 *
 * What that leaves is NOT a row with no pane behind it, which is what this
 * comment claimed until it was measured. Both rows carry the same id, so
 * clicking either selects the same pane and shows the same group. The cost is
 * two rows that DO the same thing while being free to SAY different things,
 * since each renders from its own object: measured 2026-08-05 against
 * `tabsOfProject` and `paneGroups`, two rows titled `first` and `second`
 * produced two bar rows with those titles, one group, and that group's box
 * built from `first`. So the bar can offer a row labelled from the second
 * record over a pane drawn from the first, and there is no gesture that
 * reaches the second one's pane, because there is only ever one.
 */
function paneRows(value: unknown): PaneRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const rows: PaneRecord[] = []
  for (const candidate of value) {
    if (!isPane(candidate) || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    rows.push(normalisePane(candidate))
  }
  return rows
}

/**
 * One axis of panes that all still exist, with shares that add to 1.
 *
 * Null when nothing usable is left, which the caller reads as "drop this tab".
 * Config supplies layout, never existence: a kid naming a pane no longer in
 * `panes[]` goes, and a tab with no kids left goes with it. That is also how a
 * forgotten pane's tab row clears itself, since `forgetTab` removes the pane
 * row and leaves the layout entry pointing at nothing.
 */
function normaliseLayout(value: unknown, known: Set<string>): TabLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { dir?: unknown; ratio?: unknown; kids?: unknown }
  const ratio: unknown[] = Array.isArray(candidate.ratio) ? candidate.ratio : []

  const kids: string[] = []
  const shares: unknown[] = []
  if (Array.isArray(candidate.kids)) {
    candidate.kids.forEach((kid: unknown, index: number) => {
      if (typeof kid !== 'string' || !known.has(kid) || kids.includes(kid)) return
      kids.push(kid)
      shares.push(ratio[index])
    })
  }
  if (kids.length === 0) return null

  // All or nothing, and never `[].every` — `kids` is non-empty by the guard
  // above, so this really does look at something. One unusable share is enough
  // to distrust the array: honouring a zero would render a pane the user can
  // neither see nor drag back, which is worse than ignoring a hand-edited file.
  const usable = shares.every(
    (share): share is number => typeof share === 'number' && Number.isFinite(share) && share > 0,
  )
  const total = usable ? shares.reduce<number>((sum, share) => sum + (share as number), 0) : 0
  return {
    // Anything unreadable is a row: a tab that draws wrong is recoverable by
    // dragging, a tab dropped for a bad string is not.
    dir: candidate.dir === 'col' ? 'col' : 'row',
    // Rescaled rather than trusted, because dropping a kid above leaves the
    // survivors summing to less than 1.
    ratio: usable
      ? (shares as number[]).map((share) => share / total)
      : kids.map(() => 1 / kids.length),
    kids,
  }
}

/**
 * Tab rows whose layout still describes panes that are on disk, each pane
 * claimed by at most one row.
 *
 * `normaliseLayout` dedupes kids within a row; the shrinking `known` set is
 * what dedupes them across rows. A pane in two tabs is not a shape this app
 * writes, but it is one a hand-edited or half-written file can have, and a
 * pane drawn in two tabs at once has no sane rendering. First row wins, and a
 * row left with no kids of its own is dropped exactly as one naming only dead
 * panes is. Harmless today — restore rebuilds tab membership from live tmux on
 * every launch and never consults `saved.tabs` for existence — but 2b writes
 * tab rows from the renderer, and then this is the only thing between a bad
 * file and two tabs fighting over one pane.
 */
function tabRows(value: unknown, panes: PaneRecord[]): TabRow[] {
  if (!Array.isArray(value)) return []
  const known = new Set(panes.map((pane) => pane.id))
  const rows: TabRow[] = []
  for (const row of value as unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const candidate = row as {
      id?: unknown
      groupId?: unknown
      activePaneId?: unknown
      layout?: unknown
    }
    if (typeof candidate.id !== 'string') continue
    const layout = normaliseLayout(candidate.layout, known)
    if (!layout) continue
    // Spent, so no later row can claim them. `normaliseLayout` has already
    // rescaled this row's shares over the kids it actually kept, so a row that
    // loses a kid to an earlier one still describes a whole tab.
    for (const kid of layout.kids) known.delete(kid)
    rows.push({
      id: candidate.id,
      // Defaulted to the row's own id, which is why splitting the two needed no
      // version bump: every row any earlier build wrote was named after the
      // group it was in, so `id` IS the group id for all of them, and for every
      // tab that has never re-founded. A row that has re-founded carries both.
      groupId: typeof candidate.groupId === 'string' ? candidate.groupId : candidate.id,
      // Selection has to name a pane this tab actually holds; null is "the
      // first one", which is a pane that exists.
      activePaneId:
        typeof candidate.activePaneId === 'string' && layout.kids.includes(candidate.activePaneId)
          ? candidate.activePaneId
          : null,
      layout,
    })
  }
  return rows
}

/**
 * One tab per pane, in pane order — the shape every version before v5 had,
 * where a tab *was* one pane.
 *
 * Migration's, and only migration's. `restoreWorkspace` deliberately does not
 * use it, and the reason is worth writing down so it is not re-derived: a tab
 * row's `groupId` must carry the GROUP's frozen id, and a group outlives its
 * founder, so a row whose group id followed whichever pane survived would stop
 * matching the tab on the next restore. For a one-pane tab every id here is
 * byte-identical, which is exactly why sharing this would look right and be
 * wrong for the case this milestone exists for. Restore builds its rows in
 * `tabRowFor` instead.
 */
function oneTabPerPane(panes: readonly PaneRecord[]): TabRow[] {
  return panes.map((pane) => ({
    id: pane.id,
    // A v1–v4 tab is one pane, so it is its own founder and its own group.
    groupId: pane.id,
    activePaneId: pane.id,
    layout: { dir: 'row', ratio: [1], kids: [pane.id] },
  }))
}

/** Tolerate a project row missing its optional arrays rather than dropping it. */
function normaliseProject(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    presets: Array.isArray(project.presets) ? project.presets : [],
    activeTabId: typeof project.activeTabId === 'string' ? project.activeTabId : null,
    activeBrowserTabId:
      typeof project.activeBrowserTabId === 'string' ? project.activeBrowserTabId : null,
  }
}

/**
 * Same tolerance the project rows get: a hand-edited rules array that is the
 * wrong shape costs its own contents, not every open tab.
 */
function normaliseNotifications(value: unknown): NotificationConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_NOTIFICATIONS
  const n = value as Partial<NotificationConfig>
  return {
    rules: Array.isArray(n.rules) ? n.rules : DEFAULT_NOTIFICATIONS.rules,
    muteWhenFocused:
      typeof n.muteWhenFocused === 'boolean'
        ? n.muteWhenFocused
        : DEFAULT_NOTIFICATIONS.muteWhenFocused,
    quietHours:
      typeof n.quietHours === 'object' &&
      n.quietHours !== null &&
      typeof n.quietHours.from === 'string' &&
      typeof n.quietHours.to === 'string'
        ? { from: n.quietHours.from, to: n.quietHours.to }
        : null,
  }
}

/**
 * The stored theme id, or the default.
 *
 * Same shape as `normaliseNotifications` and for the same reason: a field read
 * out of a text file is a field that can be anything, and the cost of trusting
 * this one is a window painted from an undefined palette.
 */
function normaliseTheme(value: unknown): ThemeId {
  return isThemeId(value) ? value : THEME_DEFAULT
}

/**
 * v1 had no active tab. v2 had one, globally — a notion v3 replaced with one
 * per project, so it is dropped rather than guessed at. v4 adds a tab type and
 * notification rules; neither is derivable from an older file, so both take
 * defaults. v5 splits `tabs` into flat `panes` plus tab rows carrying layout.
 *
 * v1 through v4 share one branch. All four store one row per tab because a tab
 * *was* one pane, so all four migrate by the same step — and a v1 or v2 file
 * carries no `projects` or `notifications` key at all, which makes reading for
 * them the same as not reading for them. Four copies of one migration is four
 * places for it to drift.
 *
 * Neither v1 nor v2 had projects, and their tabs all carry the slug of the
 * single hardcoded project that no longer exists. Synthesising a project from
 * that slug is the auto-create-from-slug behaviour M2b rejected, so migrated
 * panes belong to nothing and restore lists them under Unsorted.
 */
export function migrate(value: unknown): PTermConfig {
  if (!hasVersion(value)) return { ...EMPTY }
  const candidate = value as {
    projects?: unknown
    activeProjectId?: unknown
    panes?: unknown
    tabs?: unknown
    notifications?: unknown
    theme?: unknown
  }
  const rows: unknown[] = Array.isArray(candidate.projects) ? candidate.projects : []
  const projects = rows.filter(isProject).map(normaliseProject)
  const activeProjectId =
    typeof candidate.activeProjectId === 'string' ? candidate.activeProjectId : null

  // 5 through 9 share a shape. v6 added an optional pane title, v7 an optional
  // pane colour, v8 an optional file path plus a session that is optional per
  // kind, and v9 an optional theme id. In every case an older file not having
  // the field is exactly what "never set" already means, so there is nothing
  // to convert and one branch reads all five. A v7 row is a terminal row by
  // construction, because no version before v8 could express a pane without a
  // session.
  if (
    value.version === 5 ||
    value.version === 6 ||
    value.version === 7 ||
    value.version === 8 ||
    value.version === 9
  ) {
    const panes = paneRows(candidate.panes)
    return {
      version: 9,
      projects,
      activeProjectId,
      panes,
      tabs: tabRows(candidate.tabs, panes),
      notifications: normaliseNotifications(candidate.notifications),
      theme: normaliseTheme(candidate.theme),
    }
  }
  if ([1, 2, 3, 4].includes(value.version)) {
    // Lossless: a v4 tab genuinely is a one-pane tab, so its row becomes a pane
    // and a tab holding just that pane, full width and necessarily selected.
    const panes = paneRows(candidate.tabs)
    return {
      version: 9,
      projects,
      activeProjectId,
      panes,
      tabs: oneTabPerPane(panes),
      notifications: normaliseNotifications(candidate.notifications),
      theme: normaliseTheme(candidate.theme),
    }
  }
  // A version from the future: refuse to guess at its shape.
  return { ...EMPTY }
}

/**
 * The directory `PTERM_CONFIG_DIR` names, defaulting to `~/.pterm`.
 *
 * Exported because config.json is no longer the only thing that lives there:
 * the hook socket, the spool and the installed hook script are all siblings of
 * it, and every one of them must move with the escape hatch so a test never
 * reaches the real `~/.pterm`.
 */
export function configRoot(): string {
  return process.env.PTERM_CONFIG_DIR ?? join(homedir(), '.pterm')
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  /** `PTERM_CONFIG_DIR` exists so tests can point at a temp dir instead of the real config. */
  static defaultPath(): string {
    return join(configRoot(), 'config.json')
  }

  /**
   * Never throws. A missing or damaged config must not stop the app from
   * starting — the worst case is losing layout, which the user can rebuild.
   */
  async read(): Promise<PTermConfig> {
    try {
      return migrate(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch {
      return { ...EMPTY }
    }
  }

  /**
   * The `version` the file on disk claims, or null if it does not claim one.
   *
   * Null covers a missing file, a damaged one, and a file with no version
   * field — all cases where writing must go ahead. A single corrupt byte
   * locking the config against every future write would be a worse failure
   * than the one the guard below prevents.
   */
  private async versionOnDisk(): Promise<number | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as { version?: unknown }
      return typeof value.version === 'number' ? value.version : null
    } catch {
      return null
    }
  }

  /** Serialise first, then write to a temp file and rename over the target. */
  async write(config: PTermConfig): Promise<void> {
    // Before the guard, so unserialisable input still rejects rather than
    // being quietly swallowed by a refusal it has nothing to do with.
    const json = JSON.stringify(config, null, 2)

    // `migrate` returns empty for a version it does not understand, so an
    // older build reads a newer config as "no config" and then writes a full
    // one over it — losing every project, preset and rule in it. That was
    // theoretical until a v4 file existed; a packaged build and a dev build
    // have since shared one all day.
    //
    // Refused rather than thrown: the cost of running the old build is losing
    // layout changes, and a rejected promise here would surface as a failed
    // IPC call on every ordinary edit instead.
    const existing = await this.versionOnDisk()
    if (existing !== null && existing > config.version) {
      console.warn(
        `pTerm: refusing to overwrite ${this.filePath} — it is version ${existing} and this ` +
          `build writes version ${config.version}. Run the newer build, or move that file aside.`,
      )
      return
    }

    await mkdir(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      await writeFile(temp, json, 'utf8')
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}
