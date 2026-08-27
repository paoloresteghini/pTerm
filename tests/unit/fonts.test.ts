import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_FONT,
  DEFAULT_TERMINAL_FONT,
  editorFontFamily,
  isFontChoice,
  terminalFontFamily,
} from '../../src/renderer/fonts'

describe('font choices', () => {
  it('keeps the editor and terminal defaults separate while preserving their fallbacks', () => {
    expect(DEFAULT_EDITOR_FONT).toBe('system')
    expect(DEFAULT_TERMINAL_FONT).toBe('system')
    expect(editorFontFamily(DEFAULT_EDITOR_FONT)).toBe(
      "ui-monospace, SFMono-Regular, Menlo, 'pTerm Symbols', monospace",
    )
    expect(terminalFontFamily(DEFAULT_TERMINAL_FONT)).toBe(
      "ui-monospace, SFMono-Regular, Menlo, 'pTerm Symbols', 'Apple Symbols', monospace",
    )
  })

  it('accepts only font choices the settings picker can restore', () => {
    expect(isFontChoice('jetbrains')).toBe(true)
    expect(isFontChoice('not-a-font')).toBe(false)
  })

  it('can apply different choices to editor and terminal stacks', () => {
    expect(editorFontFamily('jetbrains')).toContain("'JetBrains Mono'")
    expect(terminalFontFamily('fira')).toContain("'Fira Code'")
    expect(editorFontFamily('jetbrains')).not.toBe(terminalFontFamily('fira'))
  })
})
