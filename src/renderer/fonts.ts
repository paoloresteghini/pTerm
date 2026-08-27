export const FONT_CHOICES = [
  { id: 'system', name: 'System Monospace', family: 'ui-monospace, SFMono-Regular, Menlo' },
  { id: 'menlo', name: 'Menlo', family: 'Menlo' },
  { id: 'sf-mono', name: 'SF Mono', family: "'SF Mono'" },
  { id: 'jetbrains', name: 'JetBrains Mono', family: "'JetBrains Mono'" },
  { id: 'fira', name: 'Fira Code', family: "'Fira Code'" },
] as const

export type FontChoice = (typeof FONT_CHOICES)[number]['id']

export const DEFAULT_EDITOR_FONT: FontChoice = 'system'
export const DEFAULT_TERMINAL_FONT: FontChoice = 'system'

export function isFontChoice(value: string | null): value is FontChoice {
  return FONT_CHOICES.some((choice) => choice.id === value)
}

function selectedFamily(choice: FontChoice): string {
  return FONT_CHOICES.find((item) => item.id === choice)!.family
}

export function editorFontFamily(choice: FontChoice): string {
  return `${selectedFamily(choice)}, 'pTerm Symbols', monospace`
}

export function terminalFontFamily(choice: FontChoice): string {
  return `${selectedFamily(choice)}, 'pTerm Symbols', 'Apple Symbols', monospace`
}
