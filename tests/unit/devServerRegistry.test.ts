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
