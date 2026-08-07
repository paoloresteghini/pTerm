import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'
import type { PromptEntry } from '../../shared/ipc'

/**
 * The user's saved prompts, global rather than per project.
 *
 * A file of its own beside `config.json`, for the reason `update/store.ts`
 * gives: `PTermConfig` is versioned and its migrations are on the path that
 * decides what survives a relaunch, and this list is read by nothing else.
 *
 * `configRoot()` is read at call time, not at import, so a test pointing
 * `PTERM_CONFIG_DIR` at a temp dir gets its own file.
 */
export function promptsPath(): string {
  return join(configRoot(), 'prompts.json')
}

interface PromptsFile {
  prompts: PromptEntry[]
}

/** One entry that survived parsing, or null. Anything half-formed is dropped. */
function validate(candidate: unknown): PromptEntry | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const { id, label, body } = candidate as Partial<PromptEntry>
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof label !== 'string' || label.length === 0) return null
  if (typeof body !== 'string' || body.length === 0) return null
  return { id, label, body }
}

/**
 * Every saved prompt, oldest first. Never rejects.
 *
 * A missing file is the normal state before the first prompt is written, and
 * a damaged one reads as empty rather than throwing: this list is chrome, and
 * a panel that renders nothing is a better failure than a window that will not
 * open. A single malformed entry drops itself and leaves the rest, so one bad
 * hand edit does not cost the user their other prompts.
 */
export async function readPrompts(): Promise<PromptEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(promptsPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    const { prompts } = parsed as Partial<PromptsFile>
    if (!Array.isArray(prompts)) return []
    return prompts.map(validate).filter((entry): entry is PromptEntry => entry !== null)
  } catch {
    return []
  }
}

/**
 * Atomic, like `notes/store.ts` and unlike `update/store.ts`: this holds text
 * the user typed and cannot get back, so a torn write is not a recoverable
 * inconvenience the way a forgotten "skip this version" is.
 */
async function write(prompts: PromptEntry[]): Promise<void> {
  const path = promptsPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const body: PromptsFile = { prompts }
  try {
    await writeFile(temp, JSON.stringify(body, null, 2), 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Serialises every mutation in this process against every other.
 *
 * Add and remove are both read-modify-write, and two windows (or one window
 * and a fast pair of clicks) interleaving them would lose whichever change
 * read first. This chain makes each one read the file after the previous write
 * landed. It does NOT defend against a second pTerm process, which is the same
 * bound `ConfigStore`'s own queue has.
 */
let queue: Promise<unknown> = Promise.resolve()
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  // Swallowed on the CHAIN only: a rejection still reaches the caller through
  // `next`, but must not poison every later mutation.
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * Append a prompt and return the list as it now stands on disk.
 *
 * Returns the whole list rather than the new entry: the renderer holds this
 * list and would otherwise have to guess where the new one went, and one
 * round trip that answers with the truth is cheaper than two that agree.
 */
export function addPrompt(label: string, body: string): Promise<PromptEntry[]> {
  return serialise(async () => {
    const entry: PromptEntry = { id: randomUUID(), label, body }
    const prompts = [...(await readPrompts()), entry]
    await write(prompts)
    return prompts
  })
}

/** Drop one prompt by id, and return what is left. Unknown ids are a no-op. */
export function removePrompt(id: string): Promise<PromptEntry[]> {
  return serialise(async () => {
    const before = await readPrompts()
    const after = before.filter((entry) => entry.id !== id)
    // Only write when something changed: a delete for an id another window
    // already removed should not rewrite the file.
    if (after.length !== before.length) await write(after)
    return after
  })
}
