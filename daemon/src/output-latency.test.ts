import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager, type AttachedClient } from './session-manager.js';

const config: Config = { ...DEFAULTS };
let sessions: SessionManager;
let backend: LocalPtyBackend;

beforeEach(() => {
  initLog('error');
  backend = new LocalPtyBackend();
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {}, onOutput: () => {} },
    backend,
  );
});

const ESC = String.fromCharCode(27);

/**
 * How much of the daemon a byte has to get through before a tab can see it.
 *
 * A terminal in a browser has more between the process and the pixel than one that owns its own
 * PTY, and everything done on that path before the bytes are handed on is added to the delay a
 * person feels. This measures that stretch on its own, with no socket and no browser in the way,
 * so the number is about this code.
 *
 * The work itself has to happen either way. What matters is whether it happens **before** the
 * bytes are passed on or after, and a full screen of coloured output is where that shows: an
 * agent redrawing is exactly that, many times a second.
 */
describe('what a byte waits for inside the daemon', () => {
  /** A full screen of the sort of output an agent redraws with: colour, cursor moves, text. */
  const redraw = (): Buffer => {
    const parts: string[] = [`${ESC}[H`];
    for (let i = 0; i < 45; i++) {
      parts.push(`${ESC}[${String(i + 1)};1H${ESC}[38;5;${String(30 + (i % 200))}m`);
      parts.push(`line ${String(i)} `.padEnd(180, '.'));
      parts.push(`${ESC}[0m`);
    }
    return Buffer.from(parts.join(''), 'utf8');
  };

  it("hands output on without making it wait for the daemon's own bookkeeping", () => {
    const session = sessions.create({ cols: 200, rows: 50 });
    let handedOn = 0;
    const client: AttachedClient = {
      clientId: 'watcher',
      cols: 200,
      rows: 50,
      onOutput: () => {
        handedOn = performance.now();
      },
    };
    sessions.attach(session, client);

    const chunk = redraw();
    // Warm: the first call through any path is not the one worth measuring.
    backend.deliverForTest(session.id, chunk);

    /**
     * The median, and a generous ceiling on it.
     *
     * The worst of twenty is a measurement of the machine: this file runs beside a hundred
     * others, and one collection pause between two `performance.now()` calls fails an absolute
     * threshold while the daemon is doing exactly what it should. The median moves only when the
     * work itself moves, which is what this is here to notice.
     *
     * The share of total work is not a useful measure here either, and finding out why was worth
     * more than the number: the handoff is **all** of the synchronous work. The bookkeeping is
     * not slower than the handoff, it is not on this path at all, having been moved to a later
     * tick. So what is left to pin is that handing a byte on stays cheap in itself.
     */
    const waits: number[] = [];
    for (let i = 0; i < 20; i++) {
      handedOn = 0;
      const started = performance.now();
      backend.deliverForTest(session.id, chunk);
      if (handedOn === 0) throw new Error('output was never handed on synchronously');
      waits.push(handedOn - started);
    }
    waits.sort((a, b) => a - b);
    const median = waits[Math.floor(waits.length / 2)] ?? Infinity;
    const worst = waits[waits.length - 1] ?? Infinity;

    // eslint-disable-next-line no-console
    console.log(
      `    a full redraw waits ${median.toFixed(2)} ms inside the daemon, worst ${worst.toFixed(2)}`,
    );
    expect(median).toBeLessThan(2);
    void sessions.terminate(session, { kind: 'user-kill' });
  });
});
