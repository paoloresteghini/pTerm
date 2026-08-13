import { describe, expect, it } from 'vitest'
import { DevServerRegistry } from '../../src/main/devserver/registry'

describe('DevServerRegistry', () => {
  it('returns the URL a chunk announced', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    expect(registry.urlFor('my-project')).toBe('http://localhost:5173/')
  })

  it('replaces the answer when a second pane in the same project announces later', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.observe('pane-2', 'my-project', 'Local: http://localhost:4000/\r\n')
    expect(registry.urlFor('my-project')).toBe('http://localhost:4000/')
  })

  /**
   * The recency this feature promises is recency of ANNOUNCEMENT, not of
   * output. A pane goes on emitting long after it announced: a keystroke
   * echo, a prompt redraw, an HMR log line. Each of those re-enters the
   * scanner with the announcement still sitting in that pane's carried tail,
   * and a scan that reported whatever it could see would re-file the older
   * pane's URL as the newest one, with no way back: nothing clears an entry
   * except `forget`.
   */
  it('keeps the newer pane winning when the older pane emits one more character', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.observe('pane-2', 'my-project', 'Local: http://localhost:4000/\r\n')
    registry.observe('pane-1', 'my-project', 'x')
    expect(registry.urlFor('my-project')).toBe('http://localhost:4000/')
  })

  it('keeps the newer pane winning through a prompt redraw in the older pane', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.observe('pane-2', 'my-project', 'Local: http://localhost:4000/\r\n')
    registry.observe('pane-1', 'my-project', '\x1b[2K\x1b[G$ ')
    expect(registry.urlFor('my-project')).toBe('http://localhost:4000/')
  })

  /**
   * The second-order damage from the same re-filing, and the reason the pair
   * above is not enough on its own: an entry names the pane that announced
   * it, and re-filing rewrites that name. Once the older pane owns the entry,
   * its own death takes a live server's URL down with it.
   */
  it('keeps the live server URL when the older pane dies after emitting again', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.observe('pane-2', 'my-project', 'Local: http://localhost:4000/\r\n')
    registry.observe('pane-1', 'my-project', 'x')
    registry.forget('pane-1')
    expect(registry.urlFor('my-project')).toBe('http://localhost:4000/')
  })

  /**
   * The other half of the same rule, and what stops the fix above from being
   * a per-pane dedupe on the URL string: a user who restarts the first
   * server expects the next press to go back to it. Nothing here is a chunk
   * boundary or a tail; it is the same pane saying the same thing again, and
   * that is a fresh announcement.
   */
  it('files an older pane again when it announces the same URL a second time', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.observe('pane-2', 'my-project', 'Local: http://localhost:4000/\r\n')
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    expect(registry.urlFor('my-project')).toBe('http://localhost:5173/')
  })

  it('does not let a different project affect this one', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'project-a', 'Local: http://localhost:5173/\r\n')
    registry.observe('pane-2', 'project-b', 'Local: http://localhost:9999/\r\n')
    expect(registry.urlFor('project-a')).toBe('http://localhost:5173/')
    expect(registry.urlFor('project-b')).toBe('http://localhost:9999/')
  })

  it('clears the answer when forget is called on the pane that announced it', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.forget('pane-1')
    expect(registry.urlFor('my-project')).toBeNull()
  })

  it('leaves the answer alone when forget is called on a pane that announced nothing', () => {
    const registry = new DevServerRegistry()
    registry.observe('pane-1', 'my-project', 'Local: http://localhost:5173/\r\n')
    registry.forget('pane-2')
    expect(registry.urlFor('my-project')).toBe('http://localhost:5173/')
  })

  it('returns null for a project nothing has been announced for', () => {
    const registry = new DevServerRegistry()
    expect(registry.urlFor('unknown-project')).toBeNull()
  })
})
