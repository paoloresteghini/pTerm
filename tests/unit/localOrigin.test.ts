import { describe, it, expect } from 'vitest'
import { isLoopbackUrl } from '../../src/shared/localOrigin'

describe('isLoopbackUrl', () => {
  it('accepts the loopback hosts on any port', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://localhost/',
      'https://localhost:8443/x?y=1',
      'http://127.0.0.1:3000/',
      'http://[::1]:3000/',
      'http://app.localhost:5173/',
    ]) {
      expect(isLoopbackUrl(url)).toBe(true)
    }
  })

  it('refuses everything else', () => {
    for (const url of [
      'https://github.com/',
      'http://192.168.1.10:5173/',
      'http://10.0.0.1/',
      'http://example.com/',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })

  // The interesting half. Each of these has been used to slip a non-loopback
  // host past a naive string check, so each is a case the predicate must
  // answer on the parsed URL rather than on the text.
  it('refuses hosts that merely look loopback', () => {
    for (const url of [
      'http://localhost.evil.com/',
      'http://notlocalhost/',
      'http://127.0.0.1.evil.com/',
      'https://user:pass@evil.com/?x=localhost',
      'http://evil.com#localhost',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })

  // Non-http schemes are not "a page on your dev server" and several of them
  // reach outside the browser entirely.
  it('refuses non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'about:blank',
      'chrome://settings',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      // Its hostname parses to 'localhost', a loopback match, so this case
      // only refuses if the protocol check runs before the hostname check.
      'ws://localhost/',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })

  it('refuses input it cannot parse', () => {
    for (const url of ['', 'not a url', '://', 'http://']) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })
})
