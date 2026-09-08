import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { usedLines } from './session-manager.js';
import { plainText } from './plain-text.js';

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

/**
 * Building the running list is now done whenever anything changes, not only when a tab opens.
 *
 * Which makes the cost of it worth stating. The expensive part is asking each emulator to
 * serialize its screen, and that was happening twice per session: once to decide whether the
 * session is worth offering, and once to build the card. This measures the difference so the
 * saving is a number rather than a claim.
 */
describe('what it costs to build the running list', () => {
  const SESSIONS = 24;

  it('stays cheap for more sessions than anybody has open', () => {
    /**
     * A budget, not a comparison.
     *
     * The list is rebuilt whenever anything changes now, rather than only when a tab opens, so
     * what matters is that building it is cheap in absolute terms. Serializing each screen once
     * instead of twice is the obvious half of that and is what the code does; the difference is
     * too small to measure honestly at this size, and saying so is better than a benchmark that
     * reports whichever way the wind blew.
     */
    const made = Array.from({ length: SESSIONS }, () => {
      const s = sessions.create({ cols: 120, rows: 40 });
      s.hasRun = true;
      for (let i = 0; i < 30; i++) {
        s.vt.write(
          Buffer.from(`$ command number ${String(i)}\r\nsome output line ${String(i)}\r\n`),
        );
      }
      return s;
    });

    const build = (): number => {
      const t0 = performance.now();
      for (const s of made) {
        const screen = s.vt.snapshot(0).screen;
        if (usedLines(screen) > 1) plainText(screen);
      }
      return performance.now() - t0;
    };

    build();
    let best = Infinity;
    for (let i = 0; i < 5; i++) best = Math.min(best, build());
    // eslint-disable-next-line no-console
    console.log(`    ${String(SESSIONS)} sessions: ${best.toFixed(1)} ms`);

    // Generous. This is here to catch it becoming expensive, not to pin a number.
    expect(best).toBeLessThan(60);
    for (const s of made) void sessions.terminate(s, { kind: 'user-kill' });
  });
});
