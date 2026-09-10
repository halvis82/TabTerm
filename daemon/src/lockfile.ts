import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
/**
 * How many times a contender will start again before giving the name up.
 *
 * Losing the rename means somebody else is mid-takeover, and the honest answer is to look again at
 * whatever is there now. That is a retry, and it was written as a tail call, which is a retry with
 * no bound: a name being fought over hard enough would grow the stack until the process died,
 * taking the daemon with it, which is the one outcome a lock exists to prevent. The number is
 * generous because every turn of it requires another process to have completed a whole takeover.
 */
const CLAIM_ATTEMPTS = 20;

export function claimLockFile(file: string, hooks?: ClaimHooks, attempt = 0): boolean {
  if (attempt >= CLAIM_ATTEMPTS) return false;
  if (tryCreate(file)) return true;

  // Somebody has it. Whether they are still alive is the only question left.
  let owner = 0;
  let ownerText = '';
  try {
    ownerText = readFileSync(file, 'utf8').trim();
    owner = Number(ownerText);
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
   * Stale. Taking it over is the dangerous part, and deleting the name is not the way to do it.
   *
   * Reading the owner, deciding it is gone, and then unlinking is three operations, and two
   * contenders both reach the unlink. The second one deletes a lock that the first has already
   * legitimately replaced, and both then believe they own the socket. That is the same failure as
   * the empty-window bug this function was already fixed for once, on the other side of the claim.
   *
   * `rename` is the operation that fixes it. Moving a directory entry is atomic and exactly one
   * contender can move a given entry: the loser gets ENOENT and starts again, by which time the
   * winner's fresh lock is there to be found.
   */
  hooks?.beforeTakeover?.();
  const graveyard = `${file}.stale.${String(process.pid)}.${Date.now().toString(36)}`;
  try {
    renameSync(file, graveyard);
  } catch {
    // Somebody else moved it first. Start again: whatever is there now is theirs to answer for.
    return claimLockFile(file, hooks, attempt + 1);
  }

  /**
   * And check what was actually moved, because it may not be the lock that was judged stale.
   *
   * Between the decision and the rename, another contender can complete its own takeover, in which
   * case the entry moved here is that contender's **live** claim rather than the dead one. It is
   * put back, with `link` rather than `rename` so that a third party who has claimed the name in
   * the meantime is not clobbered in turn.
   */
  let movedText = '';
  try {
    movedText = readFileSync(graveyard, 'utf8').trim();
  } catch {
    /* unreadable, which is not the same as being the claim that was judged stale */
  }
  /**
   * Compared as text, not as numbers.
   *
   * A claim this cannot parse is still a claim, and `Number('nonsense')` is `NaN`, which is not
   * equal to itself. Comparing numbers therefore concluded that every unparseable lock had been
   * replaced by somebody else and put it back, which turned a recoverable stale lock into a
   * permanent wall.
   */
  if (movedText !== ownerText) {
    /**
     * Put back, and only tidied up once it is genuinely back.
     *
     * What was moved is somebody else's **live** claim, so the copy in the graveyard is the only
     * one of it left. Deleting that when the put-back failed destroyed a running process's lock and
     * told nobody: it goes on believing it owns the socket while the name belongs to whoever won
     * the race for it. Keeping the file leaks one entry in a case that needs three contenders
     * inside one window, which is the cheaper of the two mistakes by a distance.
     */
    hooks?.beforePutBack?.();
    let putBack = false;
    try {
      linkSync(graveyard, file);
      putBack = true;
    } catch {
      /* somebody has the name now; it is theirs, and putting it back would take it from them */
    }
    if (putBack) {
      try {
        unlinkSync(graveyard);
      } catch {
        /* the second name for a claim that is back where it belongs */
      }
    }
    return false;
  }

  try {
    unlinkSync(graveyard);
  } catch {
    /* the copy of the dead owner's claim, which nothing needs any more */
  }
  return tryCreate(file);
}

/**
 * Seams for a test that has to force one interleaving in particular.
 *
 * The race being closed here is between the moment a contender decides a lock is stale and the
 * moment it acts on that decision. Nothing about it is observable from outside, and a test that
 * starts several contenders and hopes is not evidence, so the one point that matters is exposed.
 */
export interface ClaimHooks {
  /** Called after this contender has judged the lock stale, before it does anything about it. */
  beforeTakeover?: () => void;
  /**
   * Called after a claim has been moved aside and found to be somebody else's, before putting it
   * back. The window a third contender can claim the free name in, which is the case that used to
   * end with a live claim being deleted.
   */
  beforePutBack?: () => void;
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
