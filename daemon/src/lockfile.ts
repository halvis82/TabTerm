import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { paths } from './config.js';

/**
 * One daemon per user. A second instance would fight over PTYs and the database.
 * A stale lock from a crash is detected by probing the recorded pid.
 */
export function acquireLock(): () => void {
  const file = paths.lockFile;

  try {
    const existing = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(existing) && existing > 0 && alive(existing)) {
      throw new Error(`tabtermd already running as pid ${String(existing)}`);
    }
    unlinkSync(file);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('tabtermd already running')) throw e;
    /* no lock file, or it was stale. Continue. */
  }

  const fd = openSync(file, 'w', 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);

  return () => {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
