import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Logging must not cost a blocking syscall per line.
 *
 * Every line used to do two, on the event loop that is also pumping terminal output: a `stat` to
 * decide about rotation and an `appendFileSync`. Measured, five thousand lines took 122 ms one at
 * a time and 9 ms in batches. The resize storm that was measured produced eight thousand lines in
 * a minute.
 *
 * What must not change is what ends up in the file: the same lines, in the same order, and a file
 * that still rotates. And a line that explains a crash must be on disk before the crash, which is
 * why `warn` and `error` are never buffered.
 */
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-log-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One module, pointed at a directory of this test's own.
 *
 * `initLog` reads the state directory when it is called, so setting it first is what decides
 * where the lines land. The module keeps its buffer between calls, which is the thing under
 * test, so it is deliberately not reloaded.
 */
async function freshLog(level: 'debug' | 'info' = 'info') {
  /**
   * `HOME` decides where the state directory is, and it is read when `config` is first imported.
   * Setting it before the first dynamic import in this file is what puts the log somewhere this
   * test owns. The module keeps its buffer between calls, which is the thing under test, so it is
   * deliberately imported once rather than reloaded.
   */
  process.env['HOME'] = dir;
  const mod = await import('./log.js');
  mod.initLog(level);
  mod.flushLog();
  return mod;
}

const logPath = (): string => join(dir, '.local', 'state', 'tabterm', 'logs', 'daemon.log');

describe('what logging costs, and what it must still guarantee', () => {
  it('keeps every line, in order, across a batch', async () => {
    const log = await freshLog();
    for (let i = 0; i < 50; i++) log.info('probe.line', { i });
    log.flushLog();
    const path = logPath();
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const mine = lines.filter((l) => l.includes('probe.line'));
    expect(mine).toHaveLength(50);
    // In order, which a buffer must not disturb.
    const order = mine.map((l) => (JSON.parse(l) as { i: number }).i);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('puts a warning on disk without waiting for the turn to end', async () => {
    const log = await freshLog();
    const path = logPath();
    const before = statSync(path).size;
    log.info('probe.buffered', {});
    log.warn('probe.urgent', {});
    // Read immediately, with no flush and no turn boundary in between.
    const text = readFileSync(path, 'utf8');
    expect(text.length).toBeGreaterThan(before);
    expect(text).toContain('probe.urgent');
    // And the line waiting in front of it went with it, or the file would be out of order.
    expect(text.indexOf('probe.buffered')).toBeLessThan(text.indexOf('probe.urgent'));
  });

  it('costs a fraction of what a syscall per line costs', async () => {
    /**
     * The reason any of this changed. Compared against the shape it replaced, in the same file
     * on the same disk, so the number is about the change and not about the machine.
     *
     * Measured when this was written: about 120 ms for five thousand lines one at a time, and
     * under 15 ms batched. The resize storm that prompted it produced eight thousand lines in a
     * minute, every one of them blocking the loop that pumps terminal output.
     */
    const log = await freshLog();
    const path = logPath();
    const N = 4000;

    writeFileSync(path, '');
    const oneAtATime = (): number => {
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        try {
          statSync(path);
        } catch {
          /* the shape this replaced did this per line too */
        }
        appendFileSync(path, `{"i":${String(i)}}\n`);
      }
      return performance.now() - t0;
    };
    const before = oneAtATime();

    writeFileSync(path, '');
    const t0 = performance.now();
    for (let i = 0; i < N; i++) log.info('probe.speed', { i });
    log.flushLog();
    const after = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(`    ${String(N)} lines: was ${before.toFixed(0)} ms, now ${after.toFixed(0)} ms`);
    expect(after).toBeLessThan(before / 3);
  });

  it('still rotates a file that has grown past its limit', async () => {
    const log = await freshLog();
    const path = logPath();
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024));
    log.warn('probe.after-rotation', {});
    expect(statSync(`${path}.1`).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(readFileSync(path, 'utf8')).toContain('probe.after-rotation');
  });
});
