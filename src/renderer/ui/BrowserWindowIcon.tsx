/**
 * A browser window: a frame, the chrome bar under its top edge, and two dots
 * in that bar.
 *
 * Drawn rather than typed, for the reason the branch glyph in `StatusBar.tsx`
 * is, and because the `↗` that used to sit in its place is spoken for:
 * `src/renderer/IssueModal.tsx` draws it on Open on GitHub. Beside a `+`, an
 * arrow leaving a box reads as "this leaves the app" and as acting on the tab.
 * A window says what the press does: a pane opens, inside pTerm, on the
 * project.
 *
 * `currentColor`, unlike `ui/FileIcon.tsx`, which passes an explicit colour:
 * there the colour IS a file kind's signal, whereas here it is the button's
 * own classes that carry it (`text-faint`, with `enabled:hover:text-muted`
 * over the top), so a fixed colour would sit unchanged while the control lit
 * up under the pointer.
 *
 * A component rather than two copies of the path data: it is drawn by the
 * terminal tab bar and by the tabs column, which are alternative homes for
 * the same control, and one of them silently drifting into a different glyph
 * is the failure this avoids.
 */
export function BrowserWindowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 shrink-0">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.75" />
        <path d="M1.5 6.5h13" />
      </g>
      <g fill="currentColor">
        <circle cx="4" cy="4.5" r="0.7" />
        <circle cx="6.4" cy="4.5" r="0.7" />
      </g>
    </svg>
  )
}
