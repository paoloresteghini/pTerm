import type { UpdateInfo } from '../shared/ipc'

/**
 * A strip below the title bar saying a newer pTerm exists.
 *
 * Below `TitleBar` rather than inside it, deliberately. `TitleBar` is the
 * window's only `drag-region` and its own comment records why nothing in it
 * is clickable: a drag region swallows pointer events, so every interactive
 * child would need `no-drag`, and there is currently no such list to keep
 * correct. Three buttons would start one.
 *
 * There is no automatic download behind `Download`. macOS auto-apply needs a
 * code-signed bundle and this app is unsigned, so the honest gesture is to
 * open the release page and let the user take the zip. See the spec at
 * `docs/superpowers/specs/2026-08-05-update-notifier-design.md`.
 */
export function UpdateBar({
  info,
  onDownload,
  onSkip,
  onDismiss,
}: {
  info: UpdateInfo
  onDownload: () => void
  onSkip: () => void
  onDismiss: () => void
}) {
  return (
    <div
      data-testid="update-bar"
      className="flex h-[26px] shrink-0 items-center justify-center gap-3 border-b border-border bg-surface px-3 text-[11px]"
    >
      <span data-testid="update-version" className="text-muted">
        pTerm {info.version} available
      </span>
      <button
        data-testid="update-download"
        onClick={onDownload}
        className="text-fg underline underline-offset-2"
      >
        Download
      </button>
      <button data-testid="update-skip" onClick={onSkip} className="text-faint hover:text-muted">
        Skip this version
      </button>
      <button
        data-testid="update-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-faint hover:text-muted"
      >
        ✕
      </button>
    </div>
  )
}
