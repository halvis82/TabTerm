import { execFile } from 'node:child_process';
import { readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Files dropped onto a TabTerm window.
 *
 * A native terminal is handed the path of a dragged file and types it. A web page is not: Chrome
 * gives the page the bytes and the name and withholds where the file came from, on purpose. So the
 * path has to be made rather than read, which means writing a copy somewhere the shell can reach
 * and typing the path of the copy.
 *
 * The name comes from the drop, so it is attacker-controlled in the same way terminal output is:
 * a page can start a drag, and a file can be named anything a filesystem allows. Everything here
 * treats it as a label to be rebuilt rather than a path to be trusted.
 */

/** As much as one drop may carry. A frame is capped at 16 MB and base64 costs a third on top. */
export const MAX_DROP_BYTES = 8 * 1024 * 1024;

/** How long a copy is kept before it is swept up. */
export const DROP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Nothing but a filename, and a plain one. */
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * Rebuild a dropped file's name as something safe to write.
 *
 * Deliberately a list of what is allowed rather than a list of what is not: a separator, a control
 * character, a leading dot, or a name that is entirely punctuation all end up as the fallback,
 * which is harmless, rather than as something that escapes the directory.
 */
export function safeDropName(raw: string): string {
  // Only the last segment can be a filename, whichever separator was used to build the rest.
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(UNSAFE, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80);
  return cleaned === '' ? 'dropped-file' : cleaned;
}

/**
 * Where one dropped file goes.
 *
 * Prefixed with the time rather than suffixed with a counter, so two drops of the same name never
 * collide, the newest is obvious in a listing, and the sweep below can work by age alone.
 */
export function dropPath(dir: string, raw: string, now: number, salt: string): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(dir, `${stamp}-${salt}-${safeDropName(raw)}`);
}

/** Write one dropped file, and report where it landed. */
export async function writeDrop(
  dir: string,
  raw: string,
  bytes: Uint8Array,
  now: number,
  salt: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = dropPath(dir, raw, now, salt);
  // Nobody but the owner. A dropped file is as private as anything else the terminal touches.
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

/**
 * Remove copies nobody is going to open again.
 *
 * Best effort throughout. A copy that cannot be removed is not worth failing a drop over, and the
 * next drop will try again.
 */
export async function sweepDrops(dir: string, now: number, ttlMs = DROP_TTL_MS): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile() || now - st.mtimeMs < ttlMs) continue;
      await unlink(path);
      removed++;
    } catch {
      /* gone already, or not ours to remove */
    }
  }
  return removed;
}

/**
 * Whether a dropped file is an image, and so worth putting on the clipboard.
 *
 * The type the browser reports is preferred, because it comes from the file itself rather than
 * from its name. The name is the fallback for the cases where the browser offers nothing.
 */
export function isImage(type: string, name: string): boolean {
  if (type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i.test(name);
}

/** Whether it has to be turned into a PNG first. The clipboard is handed PNG data. */
export function needsPngConversion(type: string, name: string): boolean {
  return !(type === 'image/png' || /\.png$/i.test(name));
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 10000 }, (err) => {
      // `execFile` gives an Error or nothing, but the type is wider than the promise wants.
      if (err) reject(new Error(`${command} failed: ${err.message}`));
      else resolve();
    });
  });
}

/**
 * Put an image on the macOS clipboard, so an agent can take it the way a paste gives it one.
 *
 * This is how both agents actually receive an image, which was read out of their own binaries
 * rather than guessed. Claude Code binds Ctrl+V to an image paste and reads the clipboard with
 * `the clipboard as PNGf`; Codex reaches for the clipboard through osascript in the same way. So
 * the drop puts the image where they already look and then presses the key they already listen
 * for. Nothing about either agent is being emulated: the clipboard is the interface.
 *
 * Every value handed to a command is its own argument, never a string a shell parses. The path is
 * ours and the name has already been rebuilt, but a path is exactly the kind of value that stops
 * being ours the day something else calls this.
 */
export async function copyImageToClipboard(
  path: string,
  type: string,
  name: string,
): Promise<void> {
  let png = path;
  if (needsPngConversion(type, name)) {
    png = `${path}.png`;
    await run('/usr/bin/sips', ['-s', 'format', 'png', path, '--out', png]);
  }
  // AppleScript has no way to take a value except by building the script around it, so the path
  // is the one thing here that is interpolated. It is a path this module made.
  await run('/usr/bin/osascript', [
    '-e',
    `set the clipboard to (read (POSIX file ${JSON.stringify(png)}) as \u00abclass PNGf\u00bb)`,
  ]);
}
