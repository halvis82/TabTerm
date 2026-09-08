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

    let worst = 0;
    for (let i = 0; i < 20; i++) {
      handedOn = 0;
      const started = performance.now();
      backend.deliverForTest(session.id, chunk);
      worst = Math.max(worst, handedOn === 0 ? Infinity : handedOn - started);
    }

    // eslint-disable-next-line no-console
    console.log(`    a full redraw waits ${worst.toFixed(2)} ms inside the daemon`);
    /**
     * A budget, not a target. Anything on this path is felt directly, so it is here to notice
     * work being added to it rather than to pin a number down.
     */
    expect(worst).toBeLessThan(2);
    void sessions.terminate(session, { kind: 'user-kill' });
  });
});
