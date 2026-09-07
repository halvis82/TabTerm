import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager, type AttachedClient } from './session-manager.js';

const config: Config = { ...DEFAULTS };
let sessions: SessionManager;

beforeAll(() => {
  initLog('error');
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
});

const client = (
  clientId: string,
  cols: number,
  rows: number,
  estimated?: true,
): AttachedClient => ({
  clientId,
  cols,
  rows,
  ...(estimated ? { estimated: true } : {}),
  onOutput: () => {},
});

/**
 * What an attach is allowed to say about how big a terminal is.
 *
 * One PTY has one size, and a full-screen program redraws itself completely every time that size
 * changes. So a size arriving for no better reason than that somebody opened a tab is not free:
 * it is an agent reflowing at the wrong width and then back.
 *
 * A page that has just loaded has no pane with a box to measure, so it works a size out from the
 * window, and that answer is systematically too big: it knows nothing about the launcher, the
 * border or the scrollbar. Measured on a real machine it was 212 by 47 where the truth was
 * 195 by 44, and both went to the PTY, a tenth of a second apart, on every tab open.
 */
describe('the size an attach is allowed to claim', () => {
  it('believes a measured size, because that is what a measurement is for', () => {
    const session = sessions.create({ cols: 100, rows: 30 });
    sessions.attach(session, client('measured', 90, 25));
    expect(`${String(session.vt.cols)}x${String(session.vt.rows)}`).toBe('90x25');
    void sessions.kill(session);
  });

  it('ignores a guess for a terminal that already has a size', () => {
    const session = sessions.create({ cols: 195, rows: 44 });
    sessions.attach(session, client('reopened-tab', 212, 47, true));
    expect(`${String(session.vt.cols)}x${String(session.vt.rows)}`).toBe('195x44');
    void sessions.kill(session);
  });

  it('and the guess it ignored does not linger as a claim on the size', () => {
    // The claim is kept per client and the smallest across them wins, so a guess left in place
    // would go on constraining the session after the page had measured and moved on.
    const session = sessions.create({ cols: 195, rows: 44 });
    sessions.attach(session, client('reopened-tab', 80, 24, true));
    expect(`${String(session.vt.cols)}x${String(session.vt.rows)}`).toBe('195x44');
    sessions.resize(session, 'reopened-tab', 190, 40);
    expect(`${String(session.vt.cols)}x${String(session.vt.rows)}`).toBe('190x40');
    void sessions.kill(session);
  });

  it('takes the smaller of two views once both have measured', () => {
    // Two views of one session is a supported thing to have, and the smallest is the only size
    // that is correct for both. This is the behavior the guess rule must not break.
    const session = sessions.create({ cols: 195, rows: 44 });
    sessions.attach(session, client('wide', 195, 44));
    sessions.attach(session, client('narrow', 100, 30));
    expect(`${String(session.vt.cols)}x${String(session.vt.rows)}`).toBe('100x30');
    void sessions.kill(session);
  });

  it('lets a placeholder through when there is nothing better and nothing to spoil', () => {
    // A session being created has no screen to reflow, so the size it is made with is the size
    // it has until somebody measures.
    const session = sessions.create({ cols: 80, rows: 24 });
    expect(`${String(session.vt.cols)}x${String(session.vt.rows)}`).toBe('80x24');
    void sessions.kill(session);
  });
});
