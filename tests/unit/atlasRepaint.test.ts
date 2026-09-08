import { describe, it, expect } from 'vitest'
import { createFontAtlasRepair, type AtlasPane } from '../../src/renderer/lib/atlasRepaint'

/**
 * The two halves of the atlas repair, both of which are bugs when they are
 * missing rather than refinements.
 *
 * "Every pane" is the regression: xterm hands one texture atlas to every
 * terminal with a matching config, so a clear taken by the pane that just
 * mounted wipes the rasterisations the OTHER panes are still pointing at, and
 * only the pane that called it gets its render model cleared. The rest draw
 * mostly blank on their next refresh, which for this app is the moment their
 * tab comes back on screen. `lib/atlasRepaint.ts` carries the pixel counts.
 *
 * "Once" is the other half: repeating the clear on every later mount is what
 * turns a startup-only repair into something that fires whenever a tab or a
 * split is opened, which is when the user actually saw it.
 *
 * What this file cannot see is the pixels. It counts calls on a plain object;
 * that clearing a model repairs the frame was measured against real xterm and
 * the real WebGL addon in Electron, and is recorded in the module's header.
 */

interface Recorded extends AtlasPane {
  clears: number
  refreshes: Array<[number, number]>
}

function pane(rows: number): Recorded {
  return {
    rows,
    clears: 0,
    refreshes: [],
    clearTextureAtlas() {
      this.clears += 1
    },
    refresh(start: number, end: number) {
      this.refreshes.push([start, end])
    },
  }
}

describe('createFontAtlasRepair', () => {
  it('clears and redraws every mounted pane, not only the one that asked', () => {
    const repair = createFontAtlasRepair()
    const panes = [pane(24), pane(50), pane(11)]

    repair(panes)

    expect(panes.map((p) => p.clears)).toEqual([1, 1, 1])
    expect(panes.map((p) => p.refreshes)).toEqual([
      [[0, 23]],
      [[0, 49]],
      [[0, 10]],
    ])
  })

  it('runs once, however many panes hang off the same font load', () => {
    const repair = createFontAtlasRepair()
    const first = pane(24)
    const second = pane(24)

    repair([first])
    repair([second])
    repair([first, second])

    expect(first.clears).toBe(1)
    expect(first.refreshes).toEqual([[0, 23]])
    expect(second.clears).toBe(0)
    expect(second.refreshes).toEqual([])
  })

  it('gives each repair its own counter, so one app-wide run is a choice and not a global', () => {
    const one = createFontAtlasRepair()
    const other = createFontAtlasRepair()
    const target = pane(24)

    one([target])
    other([target])

    expect(target.clears).toBe(2)
  })
})
