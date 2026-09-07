import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager, type AttachedClient, type Session } from './session-manager.js';

const config: Config = { ...DEFAULTS };
let sessions: SessionManager;
let applied: string[] = [];

beforeEach(() => {
  initLog('error');
  applied = [];
  sessions = new SessionManager(
    config,
    {
      onExit: () => {},
      onStateChange: () => {},
      onResized: (_s, cols, rows) => applied.push(`${String(cols)}x${String(rows)}`),
    },
    new LocalPtyBackend(),
  );
});

const view = (clientId: string, cols: number, rows: number, estimated?: true): AttachedClient => ({
  clientId,
  cols,
  rows,
  ...(estimated ? { estimated: true } : {}),
  onOutput: () => {},
});
const sizeOf = (s: Session): string => `${String(s.vt.cols)}x${String(s.vt.rows)}`;

/**
 * One PTY has one size, and exactly one place decides what it is.
 *
 * Everything that has ever made a terminal flicker in this product has been two things believing
 * they were entitled to set the same number. So the property being checked here is not that the
 * arithmetic is right, which is a minimum, but that **settling is stable**: the same facts stated
 * twice produce one answer and one announcement, and no arrangement of views produces a size that
 * is not the answer to the facts.
 *
 * The announcement matters as much as the value. Every announcement makes a page change its grid,
 * which makes the page report a size, which comes back here. An announcement that says nothing
 * new is the first half of a loop.
 */
describe('one terminal, one size, one authority', () => {
  it('takes the smallest across the views, per dimension', () => {
    const s = sessions.create({ cols: 200, rows: 50 });
    sessions.attach(s, view('wide', 200, 40));
    sessions.attach(s, view('tall', 120, 50));
    expect(sizeOf(s)).toBe('120x40');
    void sessions.kill(s);
  });

  it('says nothing when told the same thing again', () => {
    /**
     * The one that matters. A page that hears an announcement resizes its grid, and a resized
     * grid reports its size, which arrives back here. If saying the same thing produced another
     * announcement, that is a loop with no exit, and it is exactly the loop that was measured at
     * twenty-seven thousand size changes in ten seconds.
     */
    const s = sessions.create({ cols: 100, rows: 30 });
    sessions.attach(s, view('a', 90, 25));
    const after = applied.length;
    for (let i = 0; i < 20; i++) sessions.resize(s, 'a', 90, 25);
    expect(applied.length).toBe(after);
    expect(sizeOf(s)).toBe('90x25');
    void sessions.kill(s);
  });

  it('settles in one step however the views arrive', () => {
    // Order is not something any of these can control: two tabs attach when they attach.
    const orders: [string, number, number][][] = [
      [
        ['a', 100, 30],
        ['b', 80, 40],
      ],
      [
        ['b', 80, 40],
        ['a', 100, 30],
      ],
    ];
    for (const order of orders) {
      applied = [];
      const s = sessions.create({ cols: 200, rows: 60 });
      for (const [id, cols, rows] of order) sessions.attach(s, view(id, cols, rows));
      expect(sizeOf(s)).toBe('80x30');
      // Every announcement was a real change: none of them restated the size.
      expect(new Set(applied).size).toBe(applied.length);
      void sessions.kill(s);
    }
  });

  it('gives the size back when the view that was constraining it leaves', () => {
    const s = sessions.create({ cols: 200, rows: 60 });
    sessions.attach(s, view('wide', 200, 60));
    sessions.attach(s, view('narrow', 80, 24));
    expect(sizeOf(s)).toBe('80x24');
    sessions.detach(s, 'narrow');
    expect(sizeOf(s)).toBe('200x60');
    void sessions.kill(s);
  });

  it('keeps the last size when the final view leaves, rather than reverting to a default', () => {
    // A session nobody is attached to is not a session of no size. The next tab to open it
    // reattaches to a screen that was drawn at some width, and that width is still the truth.
    const s = sessions.create({ cols: 200, rows: 60 });
    sessions.attach(s, view('only', 137, 41));
    expect(sizeOf(s)).toBe('137x41');
    sessions.detach(s, 'only');
    expect(sizeOf(s)).toBe('137x41');
    void sessions.kill(s);
  });

  it('is not moved by a view that admits it is guessing', () => {
    const s = sessions.create({ cols: 195, rows: 44 });
    applied = [];
    sessions.attach(s, view('reopened', 212, 47, true));
    expect(sizeOf(s)).toBe('195x44');
    expect(applied).toEqual([]);
    void sessions.kill(s);
  });

  it('never lands anywhere but the minimum, over every arrangement of three views', () => {
    /**
     * Swept rather than sampled. The failure this guards is not a wrong minimum, it is a size
     * arrived at by a sequence rather than by the facts: two authorities taking turns and the
     * answer depending on who spoke last.
     */
    const sizes = [
      [200, 60],
      [120, 40],
      [80, 24],
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
      [2, 0, 1],
      [1, 2, 0],
    ]) {
      const s = sessions.create({ cols: 300, rows: 80 });
      for (const i of order) {
        const [cols, rows] = sizes[i] as [number, number];
        sessions.attach(s, view(`v${String(i)}`, cols, rows));
      }
      expect(sizeOf(s)).toBe('80x24');
      // And restating everything changes nothing, whatever order that happens in either.
      const settled = applied.length;
      for (const i of order) {
        const [cols, rows] = sizes[i] as [number, number];
        sessions.resize(s, `v${String(i)}`, cols, rows);
      }
      expect(applied.length).toBe(settled);
      void sessions.kill(s);
    }
  });

  it('refuses a size no terminal could have, rather than letting one view break the rest', () => {
    // One client claiming MAX_SAFE_INTEGER rows made the VT allocate a line per row: the daemon
    // died of an out-of-memory abort and every terminal on the machine died with it.
    const s = sessions.create({ cols: 100, rows: 30 });
    sessions.attach(s, view('honest', 100, 30));
    sessions.resize(s, 'honest', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(s.vt.cols).toBeLessThan(10_000);
    expect(s.vt.rows).toBeLessThan(10_000);
    void sessions.kill(s);
  });
});
