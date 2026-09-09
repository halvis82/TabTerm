import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
   * A lock with no owner written in it is somebody at work, not somebody gone.
   *
   * A crash always leaves a valid pid, because the pid is in the file before the file is linked
   * into place. So an empty one cannot be wreckage; it is a claim in progress, and taking it is
   * the one move that ends with two processes owning one socket.
   */
  if (owner === 0) return false;

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

/**
 * Create it exclusively, already holding the owner's pid, or report that somebody else got there.
 *
 * Written to a private file first and then **linked** into place. `link` refuses to replace a name
 * that exists, so it is exclusive in the same way `wx` is, and it puts the file there with its
 * contents already in it.
 *
 * `open(wx)` followed by a write was not the same thing, and the difference was a real double
 * claim rather than a theoretical one. Between the create and the write the lock existed and was
 * empty; a second process read no pid from it, took no pid to mean no owner, removed the file and
 * claimed it. Two hosts then reached `listen()` together, one lost with EADDRINUSE and died, and
 * which one survived was decided by a race nobody meant to run. Reproduced under load about once
 * in thirty-six attempts.
 */
function tryCreate(file: string): boolean {
  const staging = `${file}.${process.pid}.${Date.now().toString(36)}`;
  try {
    writeFileSync(staging, String(process.pid), { mode: 0o600, flag: 'wx' });
  } catch {
    return false;
  }
  try {
    linkSync(staging, file);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      /* nothing to tidy */
    }
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
