export interface RepoRef {
  host: string
  owner: string
  name: string
}

function isGitHubHost(host: string): boolean {
  const lower = host.toLowerCase()
  return lower === 'github.com' || lower.endsWith('.github.com') || lower.endsWith('.ghe.com')
}

/**
 * Parses a git remote URL into a repository reference for use with `gh --repo`.
 * Accepts SSH (scp-like and ssh://) and HTTPS forms. Only accepts GitHub.com,
 * GitHub Enterprise Cloud (*.github.com), and GitHub Enterprise Server (*.ghe.com)
 * hosts. Returns null for invalid, unsupported, or non-GitHub hosts.
 *
 * Tolerates missing .git suffix, trailing slashes, and leading/trailing whitespace.
 * Requires exactly two path segments (owner and repo name) after normalization.
 */
export function parseRemote(url: string): RepoRef | null {
  const trimmed = url.trim()
  if (trimmed === '') return null

  let host: string
  let path: string

  const scp = /^(?:([^@/]+)@)?([^@/:]+):(.+)$/.exec(trimmed)
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)

  if (!scheme && scp) {
    host = scp[2]
    path = scp[3]
  } else if (scheme) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    host = parsed.hostname
    path = parsed.pathname
  } else {
    return null
  }

  if (!isGitHubHost(host)) return null

  const segments = path
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment !== '')
  if (segments.length !== 2) return null

  const [owner, name] = segments

  return { host, owner, name }
}

/**
 * Formats a repository reference for use with `gh --repo`. Returns OWNER/NAME
 * for github.com (case-insensitive) and HOST/OWNER/NAME for other hosts.
 */
export function repoArg(ref: RepoRef): string {
  return ref.host.toLowerCase() === 'github.com'
    ? `${ref.owner}/${ref.name}`
    : `${ref.host}/${ref.owner}/${ref.name}`
}
