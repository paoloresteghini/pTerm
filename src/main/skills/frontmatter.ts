/**
 * The scalar fields a skill or command file declares about itself.
 *
 * Deliberately not a YAML parser, and not a step towards one. This repo has
 * nine runtime dependencies and `npm install` is not run casually here — it
 * breaks node-pty's spawn-helper permissions and fails every integration test
 * until the postinstall repairs it. So this reads what the panel needs and
 * ignores the rest.
 *
 * The shapes handled were counted, not guessed, across the 73 skills and 36
 * commands on the target machine: 57 plain values, 14 quoted, 2 folded block
 * scalars (`brand-voice-enforcement` and `ogilvy-copywriting`), and one
 * command file carrying no `name:` at all. Anything else contributes nothing
 * rather than throwing — see the module rule in `scan.ts`.
 */
export function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const lines = text.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  // An unterminated block is not frontmatter. Reading to end-of-file instead
  // would treat a document that merely opens with a rule as a field list.
  if (end === -1) return {}

  const fields: Record<string, string> = {}
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? ''
    // Top-level keys only. An indented line is either a block scalar's
    // continuation — consumed below, and skipped here on the way back past it
    // — or a nested structure this does not read.
    if (/^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()

    if (raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const folded: string[] = []
      for (let j = i + 1; j < end; j += 1) {
        const next = lines[j] ?? ''
        // A blank line belongs to the block; an unindented one ends it.
        if (next.trim() !== '' && !/^\s/.test(next)) break
        folded.push(next.trim())
      }
      fields[key] = folded.join(' ').trim()
      continue
    }

    fields[key] = unquote(raw)
  }
  return fields
}

/** Strips one matching pair of surrounding quotes, and only a matching pair. */
function unquote(value: string): string {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1)
  }
  return value
}
