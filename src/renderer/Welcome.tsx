import type { CSSProperties } from 'react'
import mark from '../images/icon.jpg'

/**
 * The three shortcuts that put a pane on screen, which is what someone looking
 * at no panes needs.
 *
 * ⌘W, ⌘⌥arrow, ⌘⇧\ and ⌘, are all real bindings and all absent here: none of
 * them does anything when nothing is running.
 */
const SHORTCUTS = [
  { glyph: '+', keys: 'Cmd+T', label: 'new session' },
  { glyph: '▯', keys: 'Cmd+D', label: 'split right' },
  { glyph: '⊟', keys: 'Cmd+Shift+D', label: 'split down' },
]

/**
 * What the pane area shows when it has nothing to show: the name, what the app
 * is for, the shortcuts that create a pane, and one line saying what to do
 * from here.
 *
 * Nothing on it is clickable, deliberately. The row's job is to teach three
 * keystrokes, and a row of buttons would teach the mouse instead. Every action
 * named here is already a click away in the sidebar and in the tab bar's `+`,
 * both of which stay on screen around this.
 *
 * Purely presentational. `hint` is chosen by `welcomeHint` in workspace.ts,
 * where the four cases can be tested without a DOM.
 *
 * `absolute inset-0` to match the pane groups it sits among, so it centres
 * against the same box they fill. It only renders when none of them is
 * visible, so no z-index is needed to settle who paints on top: an invisible
 * group's `invisible` keeps it out of hit-testing altogether (`App.tsx`'s
 * comment on the dividers overlay), which is what actually keeps it from
 * catching input over this page. `pointer-events-none` on that group's
 * container is not enough by itself, since a descendant that opts back in
 * with `pointer-events-auto` (the divider strips do) is not covered by it.
 */
export function Welcome({ hint }: { hint: string }) {
  return (
    <div
      data-testid="welcome"
      // `isolate` makes this a stacking context, which is what confines the
      // mark's negative z-index below. Without it a `-z-10` child paints
      // behind the nearest ancestor that HAS a background, which here is the
      // pane area itself, and the mark would be invisible rather than faint.
      className="absolute inset-0 isolate flex select-none flex-col items-center justify-center gap-3"
    >
      {/* The 1024px `icon.jpg`, not the 116px `logo.png` the title bar uses:
          at this size that one would be a 4x upscale.

          Painted as a luminance MASK over a `bg-fg` box rather than drawn as
          an image, because that asset is white on OPAQUE black and has no
          alpha channel. `mix-blend-screen` was tried first and is wrong: JPEG
          compression leaves the "black" a few levels above zero, so screen
          lifts it above the app's own near-black and the mark arrives inside
          a visible grey rectangle. A luminance mask takes the same asset and
          makes black mean "not painted", which has no rectangle to leak.

          Sized in `vmin` so it stays square and scales with the window rather
          than overflowing a short one, capped in px so it does not grow
          without limit on a large display. */}
      <div
        data-testid="welcome-mark"
        aria-hidden
        className="pointer-events-none absolute -z-10 h-[min(420px,52vmin)] w-[min(420px,52vmin)] bg-fg opacity-[0.01]"
        style={
          {
            maskImage: `url(${mark})`,
            maskMode: 'luminance',
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
            // The prefixed pair for the same reason `index.css` keeps
            // `-webkit-app-region`: it costs two lines and this one is not
            // merely an alias, since unprefixed `mask-mode` is the newer half.
            WebkitMaskImage: `url(${mark})`,
            WebkitMaskSize: 'contain',
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
          } as CSSProperties
        }
      />

      <h1 className="m-0 font-mono text-[15px] font-semibold tracking-tight text-fg">pTerm</h1>
      <p className="m-0 text-[13px] text-muted">
        Manage Claude Code sessions across clients and departments.
      </p>

      <div className="mt-4 flex items-center font-mono text-[11px]">
        {SHORTCUTS.map((shortcut, index) => (
          <div key={shortcut.keys} className="flex items-center">
            {/* Between items only. A divider after the last one would read as
                a fourth item that failed to render. */}
            {index > 0 ? <span className="mx-3 text-faint">|</span> : null}
            <span className="mr-1.5 text-faint">{shortcut.glyph}</span>
            {/* Spelled `Cmd+T`, not `⌘T`: this is being read as an instruction
                rather than recognised on a menu. */}
            <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-muted">
              {shortcut.keys}
            </kbd>
            <span className="ml-1.5 text-faint">{shortcut.label}</span>
          </div>
        ))}
      </div>

      {/* `max-w` and `break-words`: the missing-directory case interpolates a
          path, and this is the one line here whose length is not fixed by its
          own copy. Without a cap it can outgrow a narrow window; `break-words`
          lets a long unbroken path itself give way rather than the line. */}
      <p
        data-testid="welcome-hint"
        className="m-0 mt-2 max-w-[320px] break-words text-center font-mono text-[11px] text-faint"
      >
        <span className="mr-1.5">&gt;_</span>
        {hint}
      </p>
    </div>
  )
}
