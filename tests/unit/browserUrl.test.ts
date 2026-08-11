/**
 * Discrimination evidence: When the SCHEME regex is replaced with a general
 * form /^[a-z][a-z0-9+.-]*:/i, one test fails: turns "example.com:8080" into
 * "https://example.com:8080". With the general pattern, the regex matches
 * `example.com` as a scheme name, returns it unchanged, and breaks the
 * expected https:// prefix. The allowlist regex prevents this regression.
 *
 * Ordering analysis: Swapping the LOOPBACK and SCHEME test order causes no
 * failures with the current regex pair, because the allowlist never overlaps
 * loopback patterns. The ordering requirement in the source code does not
 * protect against an inverted test order, but it protects against a future
 * reader simplifying the scheme regex and accidentally breaking it. Document
 * this ordering as a defense against that specific refactoring hazard.
 */

import { describe, it, expect } from 'vitest'
import { normaliseUrl } from '../../src/shared/browserUrl'

describe('normaliseUrl', () => {
  const cases: [string, string | null][] = [
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost', 'http://localhost'],
    ['localhost:5173/app/settings', 'http://localhost:5173/app/settings'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['0.0.0.0:4000', 'http://0.0.0.0:4000'],
    ['[::1]:3000', 'http://[::1]:3000'],
    ['example.com', 'https://example.com'],
    ['example.com:8080', 'https://example.com:8080'],
    ['example.com/a/b?q=1', 'https://example.com/a/b?q=1'],
    ['http://example.com', 'http://example.com'],
    ['https://example.com', 'https://example.com'],
    ['about:blank', 'about:blank'],
    ['file:///tmp/x.html', 'file:///tmp/x.html'],
    ['  example.com  ', 'https://example.com'],
    ['', null],
    ['   ', null],
  ]

  for (const [input, expected] of cases) {
    it(`turns ${JSON.stringify(input)} into ${JSON.stringify(expected)}`, () => {
      expect(normaliseUrl(input)).toBe(expected)
    })
  }
})
