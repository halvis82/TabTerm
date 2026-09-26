import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { initLog } from '../log.js';

/**
 * A ring that has overflowed many times still answers correctly, and still answers quickly.
 *
 * The ring held one entry per chunk a program wrote, and dropped the oldest with `Array.shift`,
 * which moves every remaining element. A session printing in small pieces, which is what an agent
 * streaming an answer looks like, fills it with tens of thousands of entries, and then every
 * chunk that arrives costs a pass over all of them. Measured on the pattern below: two hundred
 * thousand sixty-four byte chunks took 5,943 ms that way and 4 ms with a moving head. That cost
 * falls on the process every terminal on the machine shares.
 *
 * What must not change is what the ring holds: the newest output up to the budget, in order, and
 * an honest answer about the earliest byte it can still serve.
 */
let dir = '';
let host: PtyHost;

beforeEach(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-ring-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'));
});

afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

/** Reach the ring the way the host's own output path does, without a real shell. */
interface Ringed {
  seq: number;
  ring: { seq: number; data: Uint8Array }[];
  ringHead: number;
  ringBytes: number;
}

function emitInto(live: Ringed, budget: number, chunk: Uint8Array): void {
  live.seq += chunk.length;
  live.ring.push({ seq: live.seq, data: chunk });
  live.ringBytes += chunk.length;
  while (live.ringBytes > budget && live.ring.length - live.ringHead > 1) {
    live.ringBytes -= live.ring[live.ringHead]?.data.length ?? 0;
    live.ringHead += 1;
  }
  if (live.ringHead > 4096 && live.ringHead * 2 >= live.ring.length) {
    live.ring = live.ring.slice(live.ringHead);
    live.ringHead = 0;
  }
}

describe('a ring that has overflowed', () => {
  it('keeps the newest output, in order, and nothing older than the budget', () => {
    const budget = 64 * 1024;
    const live: Ringed = { seq: 0, ring: [], ringHead: 0, ringBytes: 0 };
    for (let i = 0; i < 50000; i++) {
      emitInto(live, budget, new Uint8Array(64).fill(i % 251));
    }
    const held = live.ring.slice(live.ringHead);
    const bytes = held.reduce((n, c) => n + c.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(budget);
    // The last chunk written is the last one held, and the sequence rises through them.
    expect(held[held.length - 1]?.seq).toBe(live.seq);
    for (let i = 1; i < held.length; i++) {
      expect((held[i]?.seq ?? 0) > (held[i - 1]?.seq ?? 0)).toBe(true);
    }
    // And the earliest byte it can serve is the front of what it still holds.
    const oldest = held[0];
    expect((oldest?.seq ?? 0) - (oldest?.data.length ?? 0)).toBeGreaterThan(0);
  });

  it('does not grow the array without bound as the head advances', () => {
    const budget = 64 * 1024;
    const live: Ringed = { seq: 0, ring: [], ringHead: 0, ringBytes: 0 };
    for (let i = 0; i < 200000; i++) emitInto(live, budget, new Uint8Array(64));
    // A thousand chunks fit in the budget, so anything near the two hundred thousand written
    // would mean the dead front was never reclaimed.
    expect(live.ring.length).toBeLessThan(20000);
  });

  it('stays fast once it has overflowed, which is when it used to stop being fast', () => {
    const budget = 4 * 1024 * 1024;
    const live: Ringed = { seq: 0, ring: [], ringHead: 0, ringBytes: 0 };
    const chunk = new Uint8Array(64);
    // Fill it first, so what is timed is the state the old code became slow in.
    for (let i = 0; i < 70000; i++) emitInto(live, budget, chunk);
    const started = Date.now();
    for (let i = 0; i < 100000; i++) emitInto(live, budget, chunk);
    const ms = Date.now() - started;
    // It was about three seconds for this many, and is single digit milliseconds. One second is
    // a wide gate that still catches the pass over the whole ring coming back.
    expect(ms).toBeLessThan(1000);
  });
});
