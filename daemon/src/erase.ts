import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What Erase everything removes from the state folder, so TabTerm starts as if it were new.
 *
 * The database (history, saved commands, favorites, recent folders, stats, saved layouts, the
 * output archive, approved project files), every terminal's saved history, the settings file,
 * remote access (the relay, paired devices and their unlock tickets), copies of dropped files, and
 * terminal checkpoints. Run only as the daemon is about to restart, since the database is open
 * until then, and a fresh daemon makes a fresh one.
 *
 * Kept, because they are not anything somebody did in TabTerm: the token the extension connects
 * with, the signing choice and backups the installer keeps, the updater's own folder, which folders
 * macOS was already asked about, and the logs, which are what explains an erase that went wrong.
 */
export const ERASED = [
  'tabterm.sqlite',
  'tabterm.sqlite-wal',
  'tabterm.sqlite-shm',
  'tabterm.db',
  'settings.json',
  'remote.json',
  'recent-dirs.json',
  'saved-items.json',
] as const;

/** Folders whose contents go, the folders themselves staying. */
export const EMPTIED = ['scrollback', 'dropped', 'terminal-checkpoints'] as const;

/** Removes it all. Returns how many things were removed. Anything already gone is fine. */
export function eraseStoredState(state: string): number {
  let removed = 0;
  for (const name of ERASED) {
    const path = join(state, name);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed++;
  }
  for (const folder of EMPTIED) {
    const dir = join(state, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
