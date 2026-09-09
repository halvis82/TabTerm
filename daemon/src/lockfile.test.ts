import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
