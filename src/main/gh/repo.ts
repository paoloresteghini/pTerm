export interface RepoRef {
  host: string
  owner: string
  name: string
}

function isGitHubHost(host: string): boolean {
  return host === 'github.com' || host.startsWith('github.')
}

/**
 * Parses a git remote URL into a repository reference for use with `gh --repo`.
 * Accepts SSH (scp-like and ssh://), HTTPS, and local paths. Only accepts
 * GitHub.com and Enterprise GitHub hosts (github.* domains). Returns null for
 * invalid or unsupported formats.
 *
 * Tolerates missing .git suffix, trailing slashes, and leading/trailing whitespace.
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
  if (segments.length < 2) return null

  const owner = segments[segments.length - 2]
  const name = segments[segments.length - 1]
  if (owner === '' || name === '') return null

  return { host, owner, name }
}

/**
 * Formats a repository reference for use with `gh --repo`. Returns OWNER/NAME
 * for github.com and HOST/OWNER/NAME for Enterprise hosts.
 */
export function repoArg(ref: RepoRef): string {
  return ref.host === 'github.com'
    ? `${ref.owner}/${ref.name}`
    : `${ref.host}/${ref.owner}/${ref.name}`
}
