import { describe, expect, it } from 'vitest';
import { PtyHostClient } from './client.js';
import { initLog } from '../log.js';

/**
 * How much replay the hold is allowed to carry, against how much was asked for.
 *
 * Live output is held back while the daemon catches up, so that a replay and the live frames that
 * overlap it can be merged in the host's own order. The replay frames are held too, because they
 * arrive the same way. So the hold has to be able to contain every replay in flight.
 *
 * It was a flat eight megabytes, sized for one ring, and a reconnect does not replay one session.
 * It replays every session the daemon is adopting. On a real machine with eight sessions and the
 * default five megabyte budget that is forty megabytes of replay arriving into an eight megabyte
 * hold, and it overflowed on all three daemon restarts in one day. What follows an overflow is the
 * watermark moving past output that never arrived, so the gap is permanent in the daemon's
 * emulator and a tab reloading is given a snapshot built from it.
 */
describe('what the hold is allowed to carry', () => {
  it('is one ring when nothing has been asked for, which is the old behaviour', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/tmp/nope', hostScript: '/tmp/nope' });
    client.setBudget(5 * 1024 * 1024);
    expect(client.holdAllowanceBytes).toBe(PtyHostClient.HOLD_LIMIT_BYTES);
  });

  /*
   * The property that matters: whatever the daemon has asked to be replayed, it can hold. A
   * budget the person raised makes both the rings and the allowance bigger together, which is the
   * relationship that was missing.
   */
  it('grows by one ring for every replay actually in flight', () => {
    initLog('error');
    const budget = 5 * 1024 * 1024;
    const client = new PtyHostClient({ socketPath: '/tmp/nope', hostScript: '/tmp/nope' });
    client.setBudget(budget);
    const base = client.holdAllowanceBytes;

    // Eight sessions being adopted at once, which is what a daemon restart looks like.
    for (let i = 0; i < 8; i++) void client.replay(`session-${String(i)}`, 0);

    expect(client.holdAllowanceBytes).toBe(base + 8 * budget);
    // And that is comfortably more than the eight megabytes that actually overflowed.
    expect(client.holdAllowanceBytes).toBeGreaterThan(8 * 1024 * 1024);
  });
});
