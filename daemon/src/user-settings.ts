import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';
import { warn } from './log.js';
import { safeError } from './safe-error.js';

/**
 * Preferences set from the interface, as opposed to configuration a person hand wrote.
 *
 * Kept in a separate file from `config.json` deliberately. That file belongs to whoever edits
 * it, and rewriting it every time a switch is flipped would reorder their keys and drop the
 * shape they chose. This one belongs to the application and can be rewritten freely.
 *
 * A setting that does not survive a restart is not a setting. That is the whole reason this
 * exists rather than living in memory next to the connection.
 */

const FILE = join(paths.state, 'settings.json');

export function readUserSettings(): Record<string, unknown> {
  if (!existsSync(FILE)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A corrupt preferences file must not stop the daemon from starting. Defaults are always
    // a usable answer here, which is not true of the session database.
    return {};
  }
}

/**
 * Written whole, or not at all.
 *
 * `writeFileSync` truncates first and then fills, so a crash or a full disk in between leaves a
 * file that exists and is not JSON. The reader answers an unparseable file with `{}`, which here
 * means every default: a person's chosen background timeout silently becomes the built-in one,
 * and the only trace is a log line about a parse failure.
 *
 * A temporary file in the same directory, then a rename. A rename within a directory is atomic,
 * so a reader sees either the previous complete settings or the new complete settings and never
 * anything in between. Same directory because a rename across filesystems is a copy, which has
 * the problem back again.
 */
export function writeUserSettings(next: Record<string, unknown>): void {
  const temporary = `${FILE}.${String(process.pid)}.tmp`;
  try {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, FILE);
  } catch (e: unknown) {
    warn('settings.write-failed', { error: safeError(e) });
    // The old file is still whole, which is the point. Leaving a half written temporary behind
    // would just be litter that the next write overwrites anyway.
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* nothing useful to say about failing to tidy up after a failure */
    }
  }
}

export function updateUserSetting(key: string, value: unknown): void {
  writeUserSettings({ ...readUserSettings(), [key]: value });
}
