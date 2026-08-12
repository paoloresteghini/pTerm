import { isLoopbackUrl } from '../../shared/localOrigin'

/**
 * Every escape sequence in this stream, by the three shapes ECMA-48 gives
 * them, in the order tried:
 *
 * 1. CSI: `\x1b[`, parameter bytes `0x30-0x3F`, intermediate bytes
 *    `0x20-0x2F`, one final byte `0x40-0x7E`. That is wider than the colour
 *    codes a dev server writes: it also covers the private forms tmux sends,
 *    such as `\x1b[?25l`, whose `?` is a parameter byte.
 * 2. OSC: `\x1b]`, a payload, and BEL or ST (`\x1b\`). The payload is
 *    required to reach its terminator before the next newline, so one split
 *    across two chunks cannot make this swallow the rest of the chunk (which
 *    could take a URL with it); an unterminated one falls through to rule 3,
 *    which drops the `\x1b]` and leaves the payload as text.
 * 3. Anything else introduced by ESC: intermediate bytes `0x20-0x2F` then
 *    one final byte `0x30-0x7E`. This is the rule that matters here.
 *    Terminfo's `sgr0` for `xterm-256color` is `\E(B\E[m`, and tmux re-emits
 *    every end-of-attribute as `sgr0`, so a real Vite banner read through a
 *    tmux client carries `\x1b(B` between the bolded port and the trailing
 *    slash. Rule 1 alone leaves that inside the URL text.
 *
 * Deliberately not handled: the other string-introducing escapes, DCS
 * (`\x1bP`), SOS, PM and APC. None appears in the captured stream this module
 * is tested against, and rule 3 already bounds them, dropping the two-byte
 * introducer and leaving the payload as ordinary text rather than consuming
 * an unknown amount of the chunk. This is not a terminal emulator: nothing
 * here interprets a sequence, it only removes it.
 */
const ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g

function stripAnsi(text: string): string {
  return text.replace(ESCAPE_PATTERN, '')
}

/**
 * A URL runs to the first whitespace or C0 control character. `\S+` alone
 * would keep a control byte, and an escape form the rule above does not
 * remove is exactly a stray control byte: this stops such a leftover from
 * being glued into the middle of a URL, where it corrupts the whole match,
 * and truncates the match at it instead. No URL can contain one anyway.
 */
const URL_PATTERN = /https?:\/\/[^\s\x00-\x1f]+/g

/**
 * How many trailing characters of the raw stream carry over between scans.
 *
 * The longest Vite banner line this module is tested against is the `Local:`
 * line of the captured chunk in `tests/unit/devServerScan.test.ts`, which is
 * 76 characters with its escape bytes counted (measured on that string, not
 * on the text it renders as). A chunk boundary can land anywhere inside that
 * line, and the tail must still hold enough of it for the next chunk to
 * complete the match. 512 gives roughly 6x headroom over that measured line,
 * enough for a longer hostname, a deeper path, or a dev server that wraps
 * more of the line in escape codes than Vite does.
 */
export const SCAN_TAIL_BYTES = 512

/**
 * Scans `tail + chunk` for the last loopback URL a dev server announced,
 * and returns it along with the new tail to carry into the next call.
 *
 * Pure: takes the previous tail and the newly read chunk, returns the URL
 * found (or null) and the trailing text to pass as `tail` next time.
 */
export function scanForLocalUrl(tail: string, chunk: string): { url: string | null; tail: string } {
  const full = tail + chunk
  const stripped = stripAnsi(full)

  const matches = stripped.match(URL_PATTERN) ?? []
  const loopbackUrls = matches.filter(isLoopbackUrl)
  const url = loopbackUrls.length > 0 ? loopbackUrls[loopbackUrls.length - 1] : null

  const newTail = full.length > SCAN_TAIL_BYTES ? full.slice(full.length - SCAN_TAIL_BYTES) : full

  return { url, tail: newTail }
}
