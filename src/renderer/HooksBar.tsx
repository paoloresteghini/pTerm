/**
 * A strip saying Claude's hooks are not wired up, so no dot will ever move.
 *
 * This exists because of how the pre-rename hook path was found. The app had
 * been dropping every hook event for days — `~/.claude/settings.json` still
 * named a script from before the PRCLI→pTerm rename — and nothing anywhere
 * said so. The dots simply stayed absent, which is also what a quiet morning
 * looks like. `migrateLegacyHooks` repairs that particular cause at startup;
 * this strip is for the next one, whatever it turns out to be.
 *
 * The condition is `HooksState.installed === false`, which is the same answer
 * the settings pane renders — one source, so the strip and the pane cannot
 * disagree about whether the install is good.
 *
 * Dismissal lasts for the run, not forever. A permanent "never ask" would need
 * a field in the config and so a version bump, and it would also be the wrong
 * default for an app whose whole subject is Claude sessions: Install is one
 * click away in the same strip, and taking it ends the question for good.
 *
 * Modelled on `UpdateBar` down to the height and the border, and sits in the
 * same place for the same reason its comment gives — below `TitleBar`, which
 * is a drag region and cannot hold anything clickable.
 */
export function HooksBar({
  onInstall,
  onDismiss,
}: {
  onInstall: () => void
  onDismiss: () => void
}) {
  return (
    <div
      data-testid="hooks-bar"
      className="flex h-[26px] shrink-0 items-center justify-center gap-3 border-b border-border bg-surface px-3 text-[11px]"
    >
      {/* `amber-400`, not a theme token: there is no `--color-warn`, and this
          is the colour `StatusDot` already draws `waiting` in. The strip says
          the waiting dot will never appear, so it says it in the dot's own
          colour rather than in a sixth semantic token added for one line. */}
      <span data-testid="hooks-bar-message" className="text-amber-400">
        Claude hooks are not installed, so no tab will show a status dot
      </span>
      <button
        data-testid="hooks-bar-install"
        onClick={onInstall}
        className="text-fg underline underline-offset-2"
      >
        Install
      </button>
      <button
        data-testid="hooks-bar-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-faint hover:text-muted"
      >
        ✕
      </button>
    </div>
  )
}
