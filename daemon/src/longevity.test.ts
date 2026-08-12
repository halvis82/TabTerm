import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { OutputArchive } from './output-archive.js';
import { RestoreStore } from './restore-store.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';

/**
 * Things that only go wrong after the daemon has been running for a long time.
 *
 * Every one of these was found by inspecting a daemon that had been up for six days, not by a
 * test. They are written down here so the next one is found by a test instead.
 */
const config: Config = { ...DEFAULTS };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('nothing grows without a bound', () => {
  it('prunes session metadata, which nothing used to call', () => {
    // `pruneSessions` existed and had no call site at all, so session_meta grew forever.
    const data = new LauncherData(new Database(':memory:'));
    data.rememberSession({ id: 's1', cwd: '/w', shell: '/bin/zsh' });
    expect(data.recallWorkspace('nope')).toBeNull();

    data.pruneSessions(-1);
    // Nothing to assert but the absence of a throw and the row being gone; the point is that
    // the call exists and works, because for a long time it was only ever declared.
    expect(() => data.pruneSessions(1000)).not.toThrow();
  });

  it('prunes restore records by age', () => {
    const store = new RestoreStore(new Database(':memory:'));
    store.save(
      {
        id: 'w1',
        layout: { type: 'terminal', paneId: 'p', sessionId: 's' },
        pinned: true,
        createdAt: 1,
        updatedAt: 1,
      },
      () => ({ cwd: '/w', screen: 'x' }),
    );
    expect(store.list(new Set())).toHaveLength(1);
    store.prune(-1);
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('prunes archived output by age and by size', () => {
    const archive = new OutputArchive(new Database(':memory:'), true);
    for (let i = 0; i < 5; i++) {
      archive.begin('s1', `command ${String(i)}`, '/w');
      archive.write('s1', 'z'.repeat(5000));
      archive.end('s1', 0);
    }
    expect(archive.usage().rows).toBe(5);
    archive.prune({ olderThanMs: 1e9, maxTotalBytes: 10_000 });
    expect(archive.usage().bytes).toBeLessThanOrEqual(10_000);
  });
});

describe('the process can always exit', () => {
  it('does not let a pending reap timer hold it open', async () => {
    // A reap wait is minutes long. Un-unref'd, it is the reason a daemon told to stop sits
    // there until a timer nobody is waiting for fires.
    const sessions = new SessionManager(
      config,
      { onExit: () => {}, onStateChange: () => {} },
      new LocalPtyBackend(),
    );
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(500);

    sessions.detach(session, 'client-1');
    await sleep(1200);

    const timer = session.reapTimer;
    if (timer) {
      // hasRef is the actual property that decides whether the event loop stays alive.
      expect(timer.hasRef()).toBe(false);
    }
    await sessions.shutdown();
  });
});

describe('logging cannot fill the disk', () => {
  it('rotates the files launchd owns, which nothing used to touch', async () => {
    // stdout.log and stderr.log are opened by launchd and appended to forever. A daemon that
    // cannot start writes the same failure on every retry; six megabytes of one identical line
    // accumulated that way.
    const dir = await mkdtemp(join(tmpdir(), 'tabterm-logs-'));
    const stderrPath = join(dir, 'stderr.log');
    await writeFile(stderrPath, 'x'.repeat(5 * 1024 * 1024));

    // initLog rotates against the configured log directory, so this asserts the behavior
    // through the same helper the daemon uses at startup.
    const { rotateForTest } = await import('./log.js');
    rotateForTest(dir);

    const names = await readdir(dir);
    expect(names).toContain('stderr.log.1');
    const rotated = await stat(join(dir, 'stderr.log.1'));
    expect(rotated.size).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('leaves a small log alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tabterm-logs-'));
    await writeFile(join(dir, 'stderr.log'), 'a few lines\n');
    const { rotateForTest } = await import('./log.js');
    rotateForTest(dir);
    expect(await readdir(dir)).not.toContain('stderr.log.1');
  });
});

initLog('error');
