import { describe, expect, it } from 'vitest';
import { PtyHostClient } from './client.js';
import { initLog } from '../log.js';

/**
 * What happens when catching up is abandoned rather than finished.
 *
 * Holding live output while a replay is fetched is what keeps the two in order. Both ways out of
 * that hold, the byte bound and the deadline, are safety nets rather than outcomes: releasing early
 * does not merely deliver late, it loses the gap. Live frames go out first and carry the session's
 * position past the replay, and every replayed byte then looks like something already seen and is
 * dropped by the same filter that stops a replay delivering twice.
 *
 * So the hold has to be big enough for a real replay, and when it is abandoned anyway the screen
 * has to say so.
 */
describe('a catch-up that is cut short', () => {
  it('carries a bound that follows the ring, rather than one smaller than it', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    // The largest scrollback setting. A hold that cannot carry this cannot carry a real replay.
    client.setBudget(50 * 1024 * 1024);
    expect(client.holdLimitBytes).toBe(50 * 1024 * 1024);
  });

  it('never drops below the floor, whatever the budget says', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    client.setBudget(1024);
    expect(client.holdLimitBytes).toBe(PtyHostClient.HOLD_LIMIT_BYTES);
  });

  it('tells the terminal its screen is incomplete instead of going quiet', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    const seen: { sessionId: string; text: string; seq: number }[] = [];
    client.onData((sessionId, data, seq) => {
      seen.push({ sessionId, text: data.toString('utf8'), seq });
    });

    client.noteCutShortForTest('s-1');
    client.reconciled();

    const notice = seen.find((s) => s.sessionId === 's-1');
    expect(notice).toBeDefined();
    expect(notice?.text).toContain('could not be recovered');
    // Sequence zero: this is not host output and must not move the session's position.
    expect(notice?.seq).toBe(0);
  });

  it('says nothing to a session whose replay had already arrived', () => {
    /*
     * Releasing the hold early loses a gap that was still being fetched. A session whose replay
     * landed has no gap, however the hold ends, and telling it otherwise is the false loss notice
     * from the watermark finding turning up somewhere new.
     */
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    let notices = 0;
    client.onData((_id, data) => {
      if (data.toString('utf8').includes('could not be recovered')) notices++;
    });
    // Nothing outstanding for this session, so nothing was lost for it.
    client.markHeldForTest('s-quiet');
    client.cutShortForTest();
    client.reconciled();
    expect(notices).toBe(0);
  });

  it('says it to a session whose replay never arrived', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    let notices = 0;
    client.onData((_id, data) => {
      if (data.toString('utf8').includes('could not be recovered')) notices++;
    });
    client.markHeldForTest('s-waiting');
    client.markReplayPendingForTest('s-waiting');
    client.cutShortForTest();
    client.reconciled();
    expect(notices).toBe(1);
  });

  it('says it once, not on every later reconcile', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    let notices = 0;
    client.onData((_id, data) => {
      if (data.toString('utf8').includes('could not be recovered')) notices++;
    });
    client.noteCutShortForTest('s-2');
    client.reconciled();
    client.reconciled();
    expect(notices).toBe(1);
  });
});
