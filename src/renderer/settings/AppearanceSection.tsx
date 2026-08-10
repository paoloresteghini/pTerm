import { useRef } from 'react'
import { cn } from '../lib/cn'
import { THEMES, THEME_IDS, type ThemeId } from '../../shared/themes'

/**
 * The theme picker: five cards, applied on click.
 *
 * No Save button and no preview thumbnail, because the app is the preview. A
 * click repaints the whole window, and this pane is itself a dialog over the
 * shell, so one click shows the modal treatment, the panel treatment and the
 * terminal at once. Those are the three surfaces the themes exist to separate.
 *
 * The swatch strip on each card is that theme's four fills in order, canvas
 * first. It is there to tell one palette from another in the list, not to
 * preview it: the preview is the window behind this dialog.
 *
 * Driven off `THEME_IDS` rather than a list written out here, so a theme added
 * to the registry appears without this file being touched.
 */
export function AppearanceSection({
  theme,
  onThemeChange,
}: {
  theme: ThemeId
  onThemeChange: (id: ThemeId) => void
}) {
  // Keyed by theme id so an arrow key can move focus to the card it selects.
  // Without this the checked state moves and the focus ring stays behind, the
  // same reason `SettingsTabs` keeps its own map.
  const cards = useRef<Partial<Record<ThemeId, HTMLButtonElement | null>>>({})
  const index = THEME_IDS.indexOf(theme)

  /**
   * Arrow keys move within the group and select as they go, which is what a
   * radiogroup does.
   *
   * Selecting on move is right here in a way it would not be on a destructive
   * control: applying is instant and reversible, so arrowing through the five
   * is the fastest way to compare them, which is the thing a user opening this
   * tab is actually trying to do.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    // Otherwise Up and Down scroll the dialog, which is `overflow-y-auto`, and
    // the selection appears to move under a jumping viewport.
    event.preventDefault()
    const next = THEME_IDS[(index + step + THEME_IDS.length) % THEME_IDS.length]
    onThemeChange(next)
    cards.current[next]?.focus()
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Theme"
        data-testid="theme-picker"
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-2"
      >
        {THEME_IDS.map((id) => {
          const { name, tokens } = THEMES[id]
          const chosen = id === theme
          return (
            <button
              key={id}
              ref={(node) => {
                cards.current[id] = node
              }}
              type="button"
              role="radio"
              aria-checked={chosen}
              // Roving tabIndex: the group is one tab stop and the arrows move
              // within it, so Tab does not walk five cards to leave the tab.
              tabIndex={chosen ? 0 : -1}
              data-testid={`theme-${id}`}
              onClick={() => onThemeChange(id)}
              className={cn(
                'flex w-[104px] cursor-default flex-col gap-1.5 rounded border bg-raised p-2 text-left',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                chosen ? 'border-accent' : 'border-border hover:border-border-strong',
              )}
            >
              {/* Inline styles rather than utilities: these are the theme's own
                  values read at render, and the point of the strip is to show a
                  palette that is NOT the one currently painting the page. */}
              <span className="flex overflow-hidden rounded-sm border border-border">
                {[tokens.bg, tokens.surface, tokens.raised, tokens.overlay].map((fill, at) => (
                  <span key={at} className="h-4 flex-1" style={{ background: fill }} />
                ))}
              </span>
              <span className={cn('text-[11px]', chosen ? 'text-fg' : 'text-label')}>{name}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-label">
        Applies straight away. Terminals keep any colour you set on them.
      </p>
    </div>
  )
}
