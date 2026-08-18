import { describe, it, expect } from 'vitest'
import { imageOnlyPaste } from '../../src/renderer/lib/terminalPaste'

/**
 * The one paste a terminal pane has to answer for itself: an image with no
 * text flavour, which Chromium's ⌘V hands over as nothing at all.
 *
 * Sabotage check results: both mutations caught as predicted.
 * 1. Drop the `text !== ''` guard: "leaves a paste carrying text alone" reddens.
 * 2. Match any type rather than `image/`: "leaves a file that is not an image
 *    alone" reddens.
 */
describe('imageOnlyPaste', () => {
  it('takes an image with no text flavour', () => {
    expect(imageOnlyPaste('', ['image/png'])).toBe(true)
  })

  // Both flavours means xterm's own paste has something to do, and what it
  // does (bracketed paste) is better than anything this could substitute.
  it('leaves a paste carrying text alone', () => {
    expect(imageOnlyPaste('hello', ['image/png', 'text/plain'])).toBe(false)
  })

  it('leaves a plain text paste alone', () => {
    expect(imageOnlyPaste('hello', ['text/plain'])).toBe(false)
  })

  // A dropped-in pdf or zip is a file the program behind the pty cannot read
  // off the clipboard, so there is nothing useful to send for it.
  it('leaves a file that is not an image alone', () => {
    expect(imageOnlyPaste('', ['application/pdf'])).toBe(false)
  })

  it('leaves an empty clipboard alone', () => {
    expect(imageOnlyPaste('', [])).toBe(false)
  })

  it('reads any image mime, not just png', () => {
    expect(imageOnlyPaste('', ['image/tiff'])).toBe(true)
  })
})
