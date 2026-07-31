import { stat } from 'node:fs/promises'

/** True only for a path that exists and is a directory. Never throws. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
