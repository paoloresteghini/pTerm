import { randomBytes } from 'node:crypto'

export const SESSION_PREFIX = 'prcli'

const SLUG_RE = /^[a-z0-9_]+$/
const ID_RE = /^[0-9a-f]{16}$/

export interface SessionNameParts {
  projectSlug: string
  id: string
}

/**
 * Reduce a display name to a session-safe slug. Lossy and deliberately so:
 * the slug is the project's identity everywhere in PRCLI, and the display
 * name is stored separately in config.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (slug.length === 0) {
    throw new Error(`slugify: no usable characters in ${JSON.stringify(name)}`)
  }
  return slug
}

export function newSessionId(): string {
  return randomBytes(8).toString('hex')
}

export function encodeSessionName({ projectSlug, id }: SessionNameParts): string {
  if (!SLUG_RE.test(projectSlug)) {
    throw new Error(`encodeSessionName: invalid project slug ${JSON.stringify(projectSlug)}`)
  }
  if (!ID_RE.test(id)) {
    throw new Error(`encodeSessionName: invalid session id ${JSON.stringify(id)}`)
  }
  return `${SESSION_PREFIX}-${projectSlug}-${id}`
}

/**
 * Slugs contain no dashes and ids are hex, so an encoded name always splits
 * into exactly three dash-separated parts. That is what makes this decodable.
 */
export function decodeSessionName(name: string): SessionNameParts | null {
  const parts = name.split('-')
  if (parts.length !== 3) return null
  const [prefix, projectSlug, id] = parts
  if (prefix !== SESSION_PREFIX) return null
  if (!SLUG_RE.test(projectSlug) || !ID_RE.test(id)) return null
  return { projectSlug, id }
}

export function isPrcliSession(name: string): boolean {
  return decodeSessionName(name) !== null
}
