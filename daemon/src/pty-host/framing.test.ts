import { describe, expect, it } from 'vitest';
import { controlFrame, decodeFrames, outputFrame } from './framing.js';

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('host framing', () => {
  it('round trips a control message', () => {
    const { frames, consumed } = decodeFrames(controlFrame({ t: 'spawn', sessionId: 'a' }));
    expect(consumed).toBeGreaterThan(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ kind: 'control', message: { t: 'spawn', sessionId: 'a' } });
  });

  it('round trips output bytes exactly', () => {
    // Terminal output is not text. Escape sequences, invalid UTF-8 and NUL all have to survive.
    const data = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x00, 0xff, 0xfe, 0x0a]);
    const { frames } = decodeFrames(outputFrame({ sessionId: 's1', seq: 7, data }));
    const out = frames[0];
    expect(out?.kind).toBe('output');
    if (out?.kind !== 'output') return;
    expect(out.frame.sessionId).toBe('s1');
    expect(out.frame.seq).toBe(7);
    expect([...out.frame.data]).toEqual([...data]);
  });

  it('keeps a sequence number that outlives any uptime', () => {
    const big = 2 ** 52;
    const { frames } = decodeFrames(
      outputFrame({ sessionId: 's', seq: big, data: new Uint8Array(0) }),
    );
    const out = frames[0];
    if (out?.kind !== 'output') throw new Error('expected output');
    expect(out.frame.seq).toBe(big);
  });

  it('reads several frames from one buffer', () => {
    const buf = concat(
      controlFrame({ t: 'a' }),
      outputFrame({ sessionId: 's', seq: 1, data: new Uint8Array([1, 2]) }),
      controlFrame({ t: 'b' }),
    );
    const { frames, consumed } = decodeFrames(buf);
    expect(frames).toHaveLength(3);
    expect(consumed).toBe(buf.length);
  });

  it('leaves a partial frame for the next read', () => {
    // A socket delivers arbitrary slices. Half a frame must not be half decoded.
    const whole = outputFrame({ sessionId: 's', seq: 1, data: new Uint8Array([1, 2, 3, 4]) });
    for (let cut = 1; cut < whole.length; cut++) {
      const { frames, consumed } = decodeFrames(whole.subarray(0, cut));
      expect(frames).toHaveLength(0);
      expect(consumed).toBe(0);
    }
    const { frames } = decodeFrames(whole);
    expect(frames).toHaveLength(1);
  });

  it('resumes correctly when a frame arrives in pieces', () => {
    const whole = concat(
      outputFrame({ sessionId: 's', seq: 1, data: new Uint8Array([9]) }),
      outputFrame({ sessionId: 's', seq: 2, data: new Uint8Array([8]) }),
    );
    const first = decodeFrames(whole.subarray(0, whole.length - 3));
    expect(first.frames).toHaveLength(1);
    const rest = concat(whole.subarray(first.consumed));
    const second = decodeFrames(rest);
    expect(second.frames).toHaveLength(1);
  });

  it('refuses a frame that claims to be enormous', () => {
    const bad = new Uint8Array(9);
    new DataView(bad.buffer).setUint32(0, 0xffffffff);
    expect(() => decodeFrames(bad)).toThrow(/too large/);
  });

  it('skips a kind it does not know rather than stalling', () => {
    // A newer host talking to an older daemon should degrade, not deadlock.
    const unknown = new Uint8Array(6);
    new DataView(unknown.buffer).setUint32(0, 2);
    unknown[4] = 0x7f;
    const buf = concat(unknown, controlFrame({ t: 'after' }));
    const { frames } = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ kind: 'control', message: { t: 'after' } });
  });
});
