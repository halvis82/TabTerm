import { describe, expect, it } from 'vitest';
import { trimOutbox } from './client.js';

/**
 * What a bounded queue for a host that is not there may throw away.
 *
 * It used to throw away the oldest, which is close to the worst possible answer: the oldest
 * message for a session is its `spawn`, so a burst of typing evicted the thing that creates the
 * terminal those keystrokes are addressed to, and a burst of resizes evicted the keystrokes.
 * Both losses were silent, and a terminal that accepts input and discards it is worse than one
 * that refuses.
 */

const write = (sessionId: string, data: string) => ({ t: 'write', sessionId, data });
const resize = (sessionId: string, cols: number) => ({ t: 'resize', sessionId, cols, rows: 24 });
const spawn = (sessionId: string) => ({ t: 'spawn', sessionId });
const typeOf = (m: unknown) => (m as { t: string }).t;
const idOf = (m: unknown) => (m as { sessionId?: string }).sessionId;

describe('what a queue for an absent host gives up first', () => {
  it('leaves a queue under the bound completely alone', () => {
    const held = [spawn('s'), write('s', 'a'), resize('s', 80)];
    expect(trimOutbox(held, 500).kept).toEqual(held);
  });

  it('keeps every keystroke through a resize storm', () => {
    // A window being dragged is what fills this queue in practice.
    const held = [
      spawn('s'),
      ...Array.from({ length: 40 }, (_, i) => write('s', String(i))),
      ...Array.from({ length: 2000 }, (_, i) => resize('s', 80 + i)),
    ];
    const { kept, lostInputFor } = trimOutbox(held, 500);

    expect(lostInputFor).toEqual([]);
    expect(
      kept.filter((m) => typeOf(m) === 'write').map((m) => (m as { data: string }).data),
    ).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
    // Only the resize that is still true, since the earlier ones are already wrong.
    const resizes = kept.filter((m) => typeOf(m) === 'resize');
    expect(resizes).toHaveLength(1);
    expect((resizes[0] as { cols: number }).cols).toBe(80 + 1999);
  });

  it('and keeps the spawn the keystrokes are addressed to, ahead of them', () => {
    const held = [spawn('s'), ...Array.from({ length: 900 }, () => write('s', 'x'))];
    const { kept } = trimOutbox(held, 500);
    const spawnAt = kept.findIndex((m) => typeOf(m) === 'spawn');
    const firstWrite = kept.findIndex((m) => typeOf(m) === 'write');
    // Either the spawn is there and comes first, or its session's input went with it.
    expect(spawnAt === -1 ? firstWrite === -1 : spawnAt < firstWrite || firstWrite === -1).toBe(
      true,
    );
  });

  it('never keeps a write for a session whose spawn it threw away', () => {
    // A write addressed to a session that was never created is not a smaller loss.
    const held = [
      spawn('a'),
      spawn('b'),
      ...Array.from({ length: 400 }, () => write('a', 'x')),
      ...Array.from({ length: 400 }, () => write('b', 'y')),
    ];
    const { kept, lostInputFor } = trimOutbox(held, 500);
    for (const id of lostInputFor) {
      expect(kept.some((m) => idOf(m) === id)).toBe(false);
    }
  });

  it('and what it gives up, it names', () => {
    const held = [
      spawn('a'),
      spawn('b'),
      ...Array.from({ length: 400 }, () => write('a', 'x')),
      ...Array.from({ length: 400 }, () => write('b', 'y')),
    ];
    const { kept, lostInputFor } = trimOutbox(held, 500);

    expect(lostInputFor.length).toBeGreaterThan(0);
    for (const id of ['a', 'b']) {
      const arrived = kept.some((m) => typeOf(m) === 'write' && idOf(m) === id);
      // Either its typing is still here, or it was named as lost. Never neither, never silent.
      expect(arrived || lostInputFor.includes(id)).toBe(true);
    }
    expect(kept.length).toBeLessThanOrEqual(500);
  });

  it('drops housekeeping before it drops anything a person did', () => {
    const held = [
      ...Array.from({ length: 400 }, (_, i) => ({ t: 'clear', sessionId: `gone-${String(i)}` })),
      spawn('s'),
      ...Array.from({ length: 200 }, () => write('s', 'x')),
    ];
    const { kept, lostInputFor } = trimOutbox(held, 500);
    expect(lostInputFor).toEqual([]);
    expect(kept.filter((m) => typeOf(m) === 'write')).toHaveLength(200);
  });

  it('always reaches the bound, whatever it is given', () => {
    // Including a queue made entirely of things that are neither input nor coalescible.
    const held = Array.from({ length: 3000 }, (_, i) => ({ t: 'kill', sessionId: String(i) }));
    expect(trimOutbox(held, 500).kept.length).toBeLessThanOrEqual(500);
  });
});
