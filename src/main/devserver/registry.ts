import { scanForLocalUrl } from './scan'

interface Announcement {
  paneId: string
  url: string
}

/**
 * Tracks, per project slug, the most recently announced dev server URL and
 * the pane that announced it. Also holds a scan tail per pane, so a chunk
 * split across reads can still complete a match.
 *
 * Nothing here is persisted: a URL from a previous run is a lie the moment
 * that server is gone, and a persisted one would open a dead port on the
 * next launch.
 */
export class DevServerRegistry {
  private readonly tails = new Map<string, string>()
  private readonly announcements = new Map<string, Announcement>()

  observe(paneId: string, projectSlug: string, chunk: string): void {
    const tail = this.tails.get(paneId) ?? ''
    const { url, tail: newTail } = scanForLocalUrl(tail, chunk)
    this.tails.set(paneId, newTail)

    if (url !== null) {
      this.announcements.set(projectSlug, { paneId, url })
    }
  }

  urlFor(projectSlug: string): string | null {
    return this.announcements.get(projectSlug)?.url ?? null
  }

  forget(paneId: string): void {
    this.tails.delete(paneId)

    for (const [projectSlug, announcement] of this.announcements) {
      if (announcement.paneId === paneId) {
        this.announcements.delete(projectSlug)
      }
    }
  }
}
