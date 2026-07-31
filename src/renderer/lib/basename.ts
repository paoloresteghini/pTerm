/** Last path segment, without pulling node:path into the renderer. */
export function basename(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}
