import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';
import { warn } from './log.js';

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

export function writeUserSettings(next: Record<string, unknown>): void {
  try {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch (e: unknown) {
    warn('settings.write-failed', { error: String(e) });
  }
}

export function updateUserSetting(key: string, value: unknown): void {
  writeUserSettings({ ...readUserSettings(), [key]: value });
}
