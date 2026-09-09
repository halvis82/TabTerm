import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimLockFile, releaseLockFile } from './lockfile.js';

/**
 * A lock has to be claimed in one operation, not three.
 *
 * Reading the file, deciding the owner is gone, and then creating it is three, and two processes
 * starting together can both read nothing, both decide they may proceed, and both believe they
 * own it. For the daemon that means two processes fighting over one database. For the PTY host it
 * is worse: the socket path is manipulated on the assumption that exactly one host owns it, so
 * the loser unlinks the winner's socket and every terminal on the machine becomes unreachable.
 */

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-lock-'));
  file = join(dir, 'test.lock');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claiming a lock', () => {
  it('succeeds when nobody has it, and records who does', () => {
    expect(claimLockFile(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(String(process.pid));
  });

  it('refuses while a living process holds it', () => {
    // This process is alive by definition, so its own claim is the strongest possible case.
    expect(claimLockFile(file)).toBe(true);
    expect(claimLockFile(file)).toBe(false);
  });

  it('takes over a lock left behind by a process that is gone', () => {
    // A crash must not require somebody to go and delete a file by hand.
    writeFileSync(file, '999999');
    expect(claimLockFile(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(String(process.pid));
  });

  it('and treats an unreadable claim as stale rather than as a wall', () => {
    writeFileSync(file, 'not a pid at all');
    expect(claimLockFile(file)).toBe(true);
  });

  it('gives exactly one winner when real hosts start together', async () => {
    /**
     * Real processes, started together, because the race this guards is between processes and a
     * single-threaded test cannot interleave the three steps it replaced. The PTY host is the
     * one that matters: its socket path is manipulated on the assumption that exactly one host
     * owns it, so two winners means the loser unlinks the winner's socket and every terminal on
     * the machine becomes unreachable.
     */
    const home = mkdtempSync(join(tmpdir(), 'tt-lockrace-'));
    const hosts = Array.from({ length: 6 }, () =>
      spawn(process.execPath, [join(process.cwd(), 'daemon/dist/pty-host.js')], {
        env: { ...process.env, TABTERM_HOME: home, TABTERM_HOST_FORCE_STOP: '1' },
        stdio: 'ignore',
      }),
    );

    try {
      /**
       * Waited for, not sampled once.
       *
       * A loser decides quickly and then exits, and a fixed window counts one that is still on
       * its way out as a survivor. That is a different failure from two hosts both claiming the
       * lock, and only one of them matters, so the count is given time to settle and the
       * assertion is made on what it settles to.
       */
      const stillRunning = () => hosts.filter((h) => h.exitCode === null && h.signalCode === null);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && stillRunning().length > 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const running = stillRunning();
      expect(running).toHaveLength(1);

      /**
       * And the five that lost left on purpose rather than crashing.
       *
       * A loser exits zero, having decided somebody else is serving. A loser that threw would
       * also be "not running", so counting survivors alone would pass for the wrong reason.
       *
       * The socket is not asserted on here. Its path moves to a short hash when the natural one
       * would exceed `sun_path`, which a temporary home comfortably does, and the pointer file
       * that records where it went is written by the daemon rather than the host, so a
       * hosts-only race has no honest way to name it without reimplementing the rule. That a
       * loser cannot remove a winner's claim is checked directly, in `releaseLockFile`.
       */
      const losers = hosts.filter((h) => h !== running[0]);
      expect(losers.map((h) => h.exitCode)).toEqual(losers.map(() => 0));
    } finally {
      for (const h of hosts) h.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is released only by the process that holds it', () => {
    /**
     * A lock judged stale and taken over by somebody else is theirs now. Removing it on the way
     * out of the process that lost it would hand a third starter a free claim while the real
     * owner is still running.
     */
    writeFileSync(file, '999999');
    releaseLockFile(file);
    expect(readFileSync(file, 'utf8').trim()).toBe('999999');

    expect(claimLockFile(file)).toBe(true);
    releaseLockFile(file);
    expect(claimLockFile(file)).toBe(true);
  });
});

describe('a claim that is still being made', () => {
  /**
   * The window that produced two owners of one socket.
   *
   * The claim used to create the file and write the pid into it as two operations. In between it
   * existed and was empty, and a second process read no pid, took that for no owner, removed the
   * file and claimed it. Both then believed they held the lock.
   *
   * An empty lock stands for that instant. A crash cannot leave one, because the pid is written
   * before the name exists, so the safe reading of an empty lock is that somebody is mid-claim.
   */
  it('is not mistaken for a lock nobody holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tt-lock-'));
    const file = join(dir, 'held.lock');
    await writeFile(file, '');

    expect(claimLockFile(file)).toBe(false);
    // And it is left alone, rather than removed on the way out.
    expect(existsSync(file)).toBe(true);
  });

  it('still takes over a lock whose owner is gone', async () => {
    // The case the staleness rule exists for, which must keep working: a real pid, no process.
    const dir = await mkdtemp(join(tmpdir(), 'tt-lock-'));
    const file = join(dir, 'stale.lock');
    await writeFile(file, '999999');

    expect(claimLockFile(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
  });

  it('leaves nothing behind when it loses', async () => {
    // The staging file is an implementation detail and must not become litter in the state
    // directory, which is the same directory the sockets and the database live in.
    const dir = await mkdtemp(join(tmpdir(), 'tt-lock-'));
    const file = join(dir, 'taken.lock');
    expect(claimLockFile(file)).toBe(true);
    expect(claimLockFile(file)).toBe(false);
    expect(readdirSync(dir)).toEqual(['taken.lock']);
  });
});

describe('two contenders that both decide the same lock is stale', () => {
  /**
   * The interleaving, forced rather than hoped for.
   *
   * Reading the owner, deciding it is gone, and acting on that decision are three operations, and
   * both contenders reach the third. Started together and left to chance this almost never
   * happens; written down it is obvious:
   *
   *   A reads the stale lock and decides to take it
   *   B reads the same lock, decides the same, and completes its takeover
   *   A resumes and acts on a decision that is no longer true
   *
   * If A's action is "unlink the name", it deletes a claim B legitimately holds and both processes
   * then believe they own the socket. For the PTY host that means the loser unlinking the winner's
   * socket, and every terminal on the machine becoming unreachable.
   */
  it('never lets the slower one delete the winner fresh claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tt-lock-'));
    const file = join(dir, 'contended.lock');
    // A pid that cannot be running: the lock is genuinely stale.
    await writeFile(file, '999999');

    let bWon = false;
    const aWon = claimLockFile(file, {
      beforeTakeover: () => {
        // B runs to completion here, inside A's decision, exactly once.
        if (bWon) return;
        bWon = claimLockFile(file);
      },
    });

    expect(bWon, 'the contender that got there first should have taken the stale lock').toBe(true);
    expect(aWon, 'and the one that was still deciding must not take it from them').toBe(false);
    // The winner's claim is intact and says so.
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    // And nothing was left lying about in the state directory.
    expect(readdirSync(dir)).toEqual(['contended.lock']);
  });

  it('still takes over a stale lock when nobody is competing for it', async () => {
    // The recovery that has to keep working: one contender, one dead owner, no ceremony.
    const dir = await mkdtemp(join(tmpdir(), 'tt-lock-'));
    const file = join(dir, 'alone.lock');
    await writeFile(file, '999999');

    expect(claimLockFile(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    expect(readdirSync(dir)).toEqual(['alone.lock']);
  });
});
