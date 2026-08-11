/**
 * Mutation check result: Swapping the LOOPBACK and SCHEME tests did not cause
 * failures. All 16 tests passed because the SCHEME regex uses an explicit
 * allowlist of known schemes (https?, file, about, etc.) rather than a general
 * "letters + colon" pattern. This explicit allowlist prevents the regex from
 * matching loopback names like `localhost:3000` or host:port combinations like
 * `example.com:8080`, even if the tests ran in the wrong order. The ordering
 * requirement in the source code exists to prevent future bugs if the regex is
 * simplified incorrectly.
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
