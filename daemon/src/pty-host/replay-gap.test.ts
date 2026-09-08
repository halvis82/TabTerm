import { describe, expect, it } from 'vitest';

/**
 * Whether a replay can tell the daemon it did not have everything.
 *
 * The host keeps a bounded ring and drops from the front. A daemon away long enough for a busy
 * session to overflow it asks for bytes that are no longer there, and used to receive what was
 * left with no sign anything was missing. The screen rebuilt from that is not a shortened one, it
 * is a wrong one, and nothing about it looks wrong.
 *
 * The arithmetic is the whole of it, so it is checked directly: a chunk's `seq` is the byte count
 * **after** it, so the first byte it carries is `seq - length`.
 */

/** What the host now reports: the earliest byte its ring can still answer for. */
function servableFrom(ring: { seq: number; length: number }[], liveSeq: number): number {
  const oldest = ring[0];
  return oldest ? oldest.seq - oldest.length : liveSeq;
}

/** What the client makes of it. */
const missing = (from: number, servable: number): number => Math.max(0, servable - from);

describe('noticing that output was lost during a reconnect', () => {
  it('reports nothing missing when the ring still reaches back far enough', () => {
    // Chunks covering bytes 0-100, 100-250, 250-400. The daemon had 250.
    const ring = [
      { seq: 100, length: 100 },
      { seq: 250, length: 150 },
      { seq: 400, length: 150 },
    ];
    expect(missing(250, servableFrom(ring, 400))).toBe(0);
  });

  it('reports nothing missing when the daemon is exactly at the ring edge', () => {
    const ring = [{ seq: 400, length: 150 }];
    // The ring starts at 250 and the daemon has 250: the next byte it needs is the first here.
    expect(missing(250, servableFrom(ring, 400))).toBe(0);
  });

  it('reports the gap when the ring has been trimmed past what was asked for', () => {
    // Everything before byte 1000 has been dropped. The daemon only had 400.
    const ring = [
      { seq: 1200, length: 200 },
      { seq: 1500, length: 300 },
    ];
    expect(missing(400, servableFrom(ring, 1500))).toBe(600);
  });

  it('reports nothing for an empty ring, which has nothing to be missing from', () => {
    // A session that has printed nothing since the daemon last saw it.
    expect(missing(900, servableFrom([], 900))).toBe(0);
  });

  it('never reports a negative gap when the daemon is somehow ahead', () => {
    const ring = [{ seq: 100, length: 100 }];
    expect(missing(500, servableFrom(ring, 100))).toBe(0);
  });
});
