/**
 * Read one end of a file without reading the rest of it.
 *
 * Three places wanted a small piece of an agent's stored conversation: the first hundred and
 * twenty-eight kilobytes to learn a session's id and title, or the last quarter of a megabyte to
 * show how it ended. Every one of them did it by reading the whole file into a string and then
 * slicing it, which reads correctly and costs the whole file.
 *
 * That is not a rounding error. A person who has been using an agent for a year has hundreds of
 * megabytes of these, with single files near a hundred, and a JavaScript string holds text as
 * sixteen-bit units, so a ninety-eight megabyte file becomes very nearly two hundred in memory.
 * Listing what could be resumed read several of them at once and the daemon aborted on an out of
 * memory, which reads as "TabTerm stopped for no reason" and left nothing behind saying why.
 *
 * A positioned read costs what it returns.
 */
import { open } from 'node:fs/promises';
import { stat } from 'node:fs/promises';

/** The first `bytes` of a file, decoded as text. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The last `bytes` of a file, decoded as text.
 *
 * A read that starts in the middle of a file almost certainly starts in the middle of a character
 * as well as in the middle of a line. Both are the caller's to deal with, and both are dealt with
 * the same way: the first line of the result is dropped, which takes the broken character with
 * it and costs one record.
 */
export async function readTail(path: string, bytes: number): Promise<string> {
  const info = await stat(path);
  const handle = await open(path, 'r');
  try {
    const want = Math.min(bytes, info.size);
    const buffer = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buffer, 0, want, Math.max(0, info.size - want));
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return info.size <= bytes ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}
