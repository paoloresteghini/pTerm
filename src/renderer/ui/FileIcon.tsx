import { iconFor, type IconKind } from '../lib/fileIcon'

/**
 * The icon on a file tree row.
 *
 * Inline SVG, not an icon font. A font is the failure this app already spent a
 * session on: a glyph the font lacks renders as a sliver or a box with nothing
 * saying why, and it depends on what is installed. An SVG either draws or is
 * visibly absent, and it ships in the bundle.
 *
 * Every shape is drawn in a 16x16 box and `currentColor` is never used — the
 * colour comes from the mapping, so one file's icon reads the same whether the
 * row is hovered, selected or dimmed.
 */

/** A document outline, which most of the language icons draw a mark inside. */
function Sheet({ color }: { color: string }) {
  return (
    <path
      d="M3.5 1.5h6l3 3v10h-9z"
      fill="none"
      stroke={color}
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  )
}

/**
 * The glyphs, by kind.
 *
 * Deliberately simple: at 12px in a dense tree, a recognisable silhouette and a
 * colour carry all the signal, and detail turns to mud. Where a real logo would
 * be unreadable at this size (React, Docker, Rust) the shape is a suggestion of
 * it rather than a reproduction.
 */
function Glyph({ kind, color }: { kind: IconKind; color: string }) {
  switch (kind) {
    case 'folder':
      return (
        <path
          d="M1.5 3.5h4.5l1.5 2h7v9h-13z"
          fill="none"
          stroke={color}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      )
    case 'react':
      return (
        <g stroke={color} strokeWidth="1.1" fill="none">
          <ellipse cx="8" cy="8" rx="6.5" ry="2.6" />
          <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(60 8 8)" />
          <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(120 8 8)" />
          <circle cx="8" cy="8" r="1.2" fill={color} stroke="none" />
        </g>
      )
    case 'typescript':
    case 'javascript':
      return (
        <g>
          <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill={color} />
          <text
            x="8"
            y="11.5"
            textAnchor="middle"
            fontSize="8"
            fontFamily="ui-monospace, monospace"
            fontWeight="700"
            fill="#0c0c0e"
          >
            {kind === 'typescript' ? 'TS' : 'JS'}
          </text>
        </g>
      )
    case 'json':
      return (
        <g stroke={color} strokeWidth="1.3" fill="none" strokeLinecap="round">
          <path d="M6 2.5C4 2.5 4.5 7 2.5 8c2 1 1.5 5.5 3.5 5.5" />
          <path d="M10 2.5c2 0 1.5 4.5 3.5 5.5-2 1-1.5 5.5-3.5 5.5" />
        </g>
      )
    case 'markdown':
      return (
        <g>
          <rect x="1" y="3.5" width="14" height="9" rx="1.3" fill="none" stroke={color} strokeWidth="1.2" />
          <path d="M3.5 10.5v-5l2 2.5 2-2.5v5" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M10.5 5.5v5M9 9l1.5 1.5L12 9" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    case 'html':
    case 'style':
      return (
        <g stroke={color} strokeWidth="1.25" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.5 4.5L2 8l3.5 3.5" />
          <path d="M10.5 4.5L14 8l-3.5 3.5" />
        </g>
      )
    case 'yaml':
    case 'config':
      return (
        <g stroke={color} strokeWidth="1.2" fill="none">
          <circle cx="8" cy="8" r="2.4" />
          <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" strokeLinecap="round" />
        </g>
      )
    case 'shell':
      return (
        <g>
          <rect x="1" y="2.5" width="14" height="11" rx="1.3" fill="none" stroke={color} strokeWidth="1.2" />
          <path d="M4 6l2.5 2L4 10M8.5 10.5h3.5" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    case 'database':
      return (
        <g stroke={color} strokeWidth="1.2" fill="none">
          <ellipse cx="8" cy="4" rx="5.5" ry="2.2" />
          <path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" />
          <path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
        </g>
      )
    case 'image':
      return (
        <g>
          <rect x="1.5" y="3" width="13" height="10" rx="1.3" fill="none" stroke={color} strokeWidth="1.2" />
          <circle cx="5.5" cy="6.5" r="1.2" fill={color} />
          <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
        </g>
      )
    case 'archive':
      return (
        <g stroke={color} strokeWidth="1.2" fill="none">
          <rect x="2" y="2.5" width="12" height="11" rx="1.3" />
          <path d="M8 2.5v3M8 7v1.5M8 10v1.5" strokeLinecap="round" />
        </g>
      )
    case 'git':
      return (
        <g stroke={color} strokeWidth="1.2" fill="none">
          <circle cx="4.5" cy="4" r="1.7" />
          <circle cx="4.5" cy="12" r="1.7" />
          <circle cx="11.5" cy="8" r="1.7" />
          <path d="M4.5 5.7v4.6M6 5.2c2.5 0.6 3.7 1.4 4.3 2.2" strokeLinecap="round" />
        </g>
      )
    case 'lock':
      return (
        <g stroke={color} strokeWidth="1.2" fill="none">
          <rect x="3.5" y="7" width="9" height="7" rx="1.3" />
          <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
        </g>
      )
    case 'docker':
      return (
        <g fill={color}>
          <rect x="2" y="7.5" width="2.2" height="2.2" />
          <rect x="4.7" y="7.5" width="2.2" height="2.2" />
          <rect x="7.4" y="7.5" width="2.2" height="2.2" />
          <rect x="4.7" y="5" width="2.2" height="2.2" />
          <rect x="7.4" y="5" width="2.2" height="2.2" />
          <path
            d="M1 10.2h11c1.6 0 2.6-.9 3-2.1-.9-.5-2-.4-2.6-.1-.2-1-.9-1.8-1.6-2.2C10 7 10.4 8.6 11 9.3 10.3 9.7 9 10 8 10H1z"
            opacity="0.9"
          />
        </g>
      )
    case 'python':
    case 'go':
    case 'rust':
    case 'php':
    case 'ruby':
    case 'text':
    case 'file':
    default:
      return (
        <g>
          <Sheet color={color} />
          <path d="M9.5 1.5v3h3" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
        </g>
      )
  }
}

/**
 * `aria-hidden` and no title: the row's own text already names the file, and a
 * second accessible name per row would double every entry a screen reader
 * reads out.
 */
export function FileIcon({ name, isDir = false }: { name: string; isDir?: boolean }) {
  const { kind, color } = iconFor(name, isDir)
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className="mr-1.5 shrink-0"
      style={{ display: 'block' }}
    >
      <Glyph kind={kind} color={color} />
    </svg>
  )
}
