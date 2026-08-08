/**
 * Which icon and colour a file tree row gets.
 *
 * A mapping, kept pure and away from the component so it can be tested: this
 * repo's vitest runs `environment: 'node'`, so logic inside a `.tsx` cannot be
 * unit tested at all.
 *
 * The icons themselves are inline SVG in `ui/FileIcon.tsx` rather than an icon
 * font. An icon font is exactly the failure this app just spent a session on:
 * a glyph the font does not have renders as a sliver or a box, and nothing
 * says why. An SVG either draws or is visibly absent.
 */

/** Every shape `ui/FileIcon.tsx` knows how to draw. */
export type IconKind =
  | 'folder'
  | 'react'
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'style'
  | 'html'
  | 'yaml'
  | 'shell'
  | 'python'
  | 'go'
  | 'rust'
  | 'php'
  | 'ruby'
  | 'database'
  | 'image'
  | 'archive'
  | 'git'
  | 'config'
  | 'lock'
  | 'docker'
  | 'text'
  | 'file'

export interface FileIcon {
  kind: IconKind
  /** Hex, so the caller can hand it straight to `fill`/`color`. */
  color: string
}

/*
 * Colours are picked to read on this app's dark surfaces and to be
 * distinguishable from one another at 12px, which is the size the tree draws.
 * They are close to the conventions people already know from editors — TypeScript
 * blue, Markdown blue-grey, shell green — because an icon colour that disagrees
 * with every other tool is a thing to learn rather than a thing to recognise.
 */
const COLORS: Record<IconKind, string> = {
  folder: '#7d8590',
  react: '#61dafb',
  typescript: '#3178c6',
  javascript: '#f0db4f',
  json: '#cbcb41',
  markdown: '#519aba',
  style: '#42a5f5',
  html: '#e44d26',
  yaml: '#cb4b16',
  shell: '#89e051',
  python: '#3572a5',
  go: '#00add8',
  rust: '#dea584',
  php: '#a074c4',
  ruby: '#cc342d',
  database: '#f29221',
  image: '#a074c4',
  archive: '#a1a1aa',
  git: '#f14e32',
  config: '#8b949e',
  lock: '#8b949e',
  docker: '#2496ed',
  text: '#a1a1aa',
  file: '#8b949e',
}

/**
 * Matched on the WHOLE name, before the extension is looked at.
 *
 * Needed for two reasons. A dotfile has no extension in the sense the split
 * below means — `.env` splits to `env`, which would collide with anything else
 * claiming that word — and a name like `package-lock.json` is a lock file that
 * happens to end in `.json`, which the extension table would call JSON and make
 * indistinguishable from `package.json`.
 */
const BY_NAME: Record<string, IconKind> = {
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.env': 'config',
  '.editorconfig': 'config',
  '.npmrc': 'config',
  '.prettierrc': 'config',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  makefile: 'shell',
  'package-lock.json': 'lock',
  'composer.lock': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'cargo.lock': 'lock',
  'gemfile.lock': 'lock',
}

const BY_EXTENSION: Record<string, IconKind> = {
  tsx: 'react',
  jsx: 'react',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'config',
  ini: 'config',
  conf: 'config',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  py: 'python',
  go: 'go',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  sql: 'database',
  db: 'database',
  sqlite: 'database',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  zip: 'archive',
  gz: 'archive',
  tar: 'archive',
  tgz: 'archive',
  txt: 'text',
  log: 'text',
  csv: 'text',
}

/**
 * The icon for one entry.
 *
 * A directory is always a folder, whatever it is called: a directory named
 * `styles.css` is a real thing and giving it a stylesheet icon would be a lie
 * about what clicking it does.
 *
 * The extension is taken from the LAST dot, so `vite.config.ts` is TypeScript
 * rather than a config file, and `export.query-model.stub` reads as `stub`.
 */
export function iconFor(name: string, isDir = false): FileIcon {
  if (isDir) return { kind: 'folder', color: COLORS.folder }

  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return { kind: byName, color: COLORS[byName] }

  // A leading dot is not a separator: `.env.example` should be found by its
  // `.env` prefix rule below, not read as an `example` extension.
  const dot = lower.lastIndexOf('.')
  const extension = dot > 0 ? lower.slice(dot + 1) : ''
  const byExtension = BY_EXTENSION[extension]
  if (byExtension) return { kind: byExtension, color: COLORS[byExtension] }

  // `.env.local`, `.env.production` and friends, which are config whatever
  // suffix a project puts on them.
  if (lower.startsWith('.env')) return { kind: 'config', color: COLORS.config }
  if (lower.startsWith('.')) return { kind: 'config', color: COLORS.config }

  return { kind: 'file', color: COLORS.file }
}
