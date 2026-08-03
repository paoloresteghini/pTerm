import logo from '../images/logo.png'

/**
 * The strip that makes the window movable, and the only thing in the app that
 * does.
 *
 * `src/main/index.ts` opens the window with `titleBarStyle: 'hiddenInset'`,
 * which takes away the title bar the OS would otherwise have given the user to
 * drag. Electron's rule for that case is explicit: an app that removes the
 * default title bar has to nominate its own draggable areas, or the window
 * cannot be moved at all. Nothing here ever did, so from the first commit that
 * set `hiddenInset` until this one the window opened centred and stayed there.
 *
 * A strip of its own rather than the tab bar, which was the other candidate: a
 * draggable region swallows every pointer event inside it, so making the tab
 * bar draggable would have meant marking each tab, each close button and the
 * `+` as `no-drag` and getting all of them right. Nothing in here is
 * clickable, so there is no such list to keep correct.
 *
 * It also gives the traffic lights a band of their own. `hiddenInset` leaves
 * them floating over whatever is at the top left, which until now was the
 * sidebar.
 */
export function TitleBar() {
  return (
    <div
      data-testid="titlebar"
      className="drag-region flex h-[38px] shrink-0 items-center justify-center border-b border-border bg-surface"
    >
      {/* Centred rather than set after the traffic lights: the lights already
          occupy the left, and a small mark trailing them reads as though it
          failed to line up with anything. Empty alt because the strip is
          decoration, and the app is named in the window's own title and on the
          welcome page. */}
      <img src={logo} alt="" className="h-[15px] w-auto opacity-80" />
    </div>
  )
}
