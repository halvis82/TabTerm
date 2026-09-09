import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { paths } from './config.js';

/**
 * Claim a lock file, or find out who already has it.
 *
 * The claim itself has to be one operation. Reading the file, deciding the owner is gone, and then
 * creating it is three, and two processes starting together can both read nothing, both decide
 * they may proceed, and both believe they own it. For the daemon that means two processes fighting
 * over the same database; for the PTY host it means two processes owning one socket path, and the
 * loser unlinking the winner's socket takes every terminal on the machine with it.
 *
 * `wx` is the whole answer: it creates the file and fails if it is already there, in one call the
 * kernel does not interleave. Everything else here is about a lock left behind by a process that
 * crashed, which is a real situation and must not require a person to go and delete a file.
 *
 * The recovery is deliberately not a loop. One retry after removing a stale claim is enough: if
 * somebody else took it in between, they hold it, and this process is the one that should stop.
 */
export function claimLockFile(file: string): boolean {
  if (tryCreate(file)) return true;

  // Somebody has it. Whether they are still alive is the only question left.
  let owner = 0;
  try {
    owner = Number(readFileSync(file, 'utf8').trim());
  } catch {
    // It went away between the failed create and this read, which means the owner released it.
    return tryCreate(file);
  }
  if (Number.isInteger(owner) && owner > 0 && alive(owner)) return false;

  /**
   * Stale, so remove it and try once more.
   *
   * Removing a claim that somebody else has just made would be the one dangerous move here, so
   * the retry is exclusive too: if another process created it in the meantime, this fails and
   * stops, which is the right answer for whichever of the two got here second.
   */
  try {
    unlinkSync(file);
  } catch {
    /* somebody else tidied it first, which is fine */
  }
  return tryCreate(file);
}

/** Create it exclusively and write who owns it, or report that somebody else got there. */
function tryCreate(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch {
    return false;
  }
  try {
    writeFileSync(fd, String(process.pid));
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Give up a lock, and only if it is still this process's to give up.
 *
 * A lock judged stale and taken over by somebody else is now theirs. Removing it on the way out
 * of the process that lost it would hand a third starter a free claim while the real owner is
 * still running.
 */
export function releaseLockFile(file: string): void {
  try {
    if (Number(readFileSync(file, 'utf8').trim()) !== process.pid) return;
    unlinkSync(file);
  } catch {
    /* already gone, or never ours */
  }
}

/**
 * One daemon per user. A second instance would fight over PTYs and the database.
 * A stale lock from a crash is detected by probing the recorded pid.
 */
export function acquireLock(): () => void {
  const file = paths.lockFile;
  if (!claimLockFile(file)) {
    let owner = '';
    try {
      owner = readFileSync(file, 'utf8').trim();
    } catch {
      /* it went away while we were failing to take it */
    }
    throw new Error(`tabtermd already running as pid ${owner}`);
  }
  return () => {
    releaseLockFile(file);
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
