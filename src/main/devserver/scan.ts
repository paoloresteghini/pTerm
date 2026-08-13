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
 *    an end-of-attribute as `sgr0` rather than as the code the program wrote,
 *    so a real Vite banner read through a tmux client carries `\x1b(B`
 *    between the bolded port and the trailing slash. Rule 1 alone leaves that
 *    inside the URL text. Not every end-of-attribute is rewritten that way:
 *    in the captured chunk in `tests/unit/devServerScan.test.ts` the bold-off
 *    (`\x1b[22m` as Vite writes it) comes through as `sgr0` while the
 *    colour-off passes through unchanged as a bare `\x1b[39m`. One rewritten
 *    escape inside the URL is all it takes, which is why rule 3 is here.
 *
 * Deliberately not handled: the other string-introducing escapes, DCS
 * (`\x1bP`), SOS, PM and APC. None appears in the captured stream this module
 * is tested against, and rule 3 already bounds them, dropping the two-byte
 * introducer and leaving the payload as ordinary text rather than consuming
 * an unknown amount of the chunk. This is not a terminal emulator: nothing
 * here interprets a sequence, it only removes it.
 */
const ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g

/**
 * Strips those escapes out of `full`, and reports how many characters of the
 * result came from the first `rawTailLength` characters of the input.
 *
 * That second number is what `scanForLocalUrl` gates its answer on, and
 * stripping the tail on its own would not give it: an escape straddling the
 * boundary is removed whole from the joined buffer, while the fragment of it
 * left at the end of the tail is not an escape at all and survives a strip of
 * the tail alone. The captured chunk's split test cuts the stream on exactly
 * such a fragment, a bare ESC, which stripping the tail by itself keeps and
 * which would then push the boundary one character past the announcement's
 * only new character. Counting removals by their offset is exact instead:
 * removal preserves order, so every surviving character of the tail comes
 * before every surviving character of the chunk.
 */
function stripAnsi(full: string, rawTailLength: number): { text: string; tailLength: number } {
  let removedFromTail = 0
  const text = full.replace(ESCAPE_PATTERN, (escape: string, offset: number) => {
    removedFromTail += Math.max(0, Math.min(offset + escape.length, rawTailLength) - offset)
    return ''
  })
  return { text, tailLength: rawTailLength - removedFromTail }
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
 * A dev server announcement, as opposed to any other loopback URL that
 * happens to go past: loopback, and carrying a port.
 *
 * The port is the entire point of reading the stream. `new URL()` reports an
 * empty `port` for `http://localhost/docs`, so filing that origin would send
 * a press to port 80, and it would go there for the rest of the session:
 * nothing ever downgrades a filed entry, only `forget` removes one. Ordinary
 * prose in a pane reaches this, not just a truncated chunk.
 *
 * Refused here rather than in `isLoopbackUrl`, which is the only loopback
 * predicate in this codebase and is the security boundary an agent-driven
 * browser pane is held to. Being permissive is right there and wrong here.
 *
 * An origin spelling the scheme's own default port (`http://localhost:80/`)
 * parses with an empty `port` too, and is refused with the rest. That corner
 * is deliberate: binding those ports needs root, and refusing one costs a
 * blank pane, while accepting a portless origin costs a wrong pane that
 * sticks.
 */
function announcesLoopbackPort(raw: string): boolean {
  if (!isLoopbackUrl(raw)) return false
  try {
    return new URL(raw).port !== ''
  } catch {
    return false
  }
}

/**
 * How many trailing characters of the raw stream carry over between scans.
 *
 * The longest Vite banner line this module is tested against is the
 * `Network:` line of the captured chunk in
 * `tests/unit/devServerScan.test.ts`, 88 characters with its escape bytes
 * counted (measured on that string, not on the text it renders as; the
 * `Local:` line that carries the URL is 76 by the same count, and the whole
 * captured chunk is 174). A chunk boundary can land anywhere inside such a
 * line, and the tail must still hold enough of it for the next chunk to
 * complete the match. 512 gives roughly 6x headroom over the longer measured
 * line, enough for a longer hostname, a deeper path, or a dev server that
 * wraps more of the line in escape codes than Vite does.
 */
export const SCAN_TAIL_BYTES = 512

/**
 * Scans `tail + chunk` for the last dev server URL NEWLY announced in it, and
 * returns it along with the new tail to carry into the next call.
 *
 * Newly, because the tail is up to 512 characters the previous call already
 * scanned. What this answers is a question about announcements, not about
 * what the buffer currently contains: a caller files the answer as the most
 * recent thing said, and a pane goes on emitting long after it has spoken
 * (an echoed keystroke, a prompt redraw, an HMR line). Every one of those
 * arrives with the earlier announcement still in that pane's tail, and
 * answering with it again would let a pane that has fallen silent outrank
 * one that announced later, permanently.
 *
 * Only a match lying WHOLLY inside the tail's own characters is suppressed.
 * One that starts in the tail and ends in the chunk is the split
 * announcement the tail exists to complete, and the same URL said a second
 * time in a later chunk is a fresh announcement and is reported again: a
 * user restarting the other server and pressing the button relies on it.
 *
 * Pure: takes the previous tail and the newly read chunk, returns the URL
 * found (or null) and the trailing text to pass as `tail` next time.
 */
export function scanForLocalUrl(tail: string, chunk: string): { url: string | null; tail: string } {
  const full = tail + chunk
  const { text, tailLength } = stripAnsi(full, tail.length)

  let url: string | null = null
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index + match[0].length <= tailLength) continue
    if (announcesLoopbackPort(match[0])) url = match[0]
  }

  const newTail = full.length > SCAN_TAIL_BYTES ? full.slice(full.length - SCAN_TAIL_BYTES) : full

  return { url, tail: newTail }
}
