import { describe, expect, it } from 'vitest';
import {
  ackFrame,
  decodeFrame,
  encodeFrame,
  FrameType,
  MAX_FRAME_BYTES,
  ProtocolError,
  PROTOCOL_VERSION,
  controlFrame,
  inputFrame,
  outputFrame,
  type ControlMessage,
  type Frame,
} from './protocol.js';

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

describe('frame codec', () => {
  it('round-trips control messages', () => {
    const messages: ControlMessage[] = [
      { t: 'auth', v: PROTOCOL_VERSION, role: 'data', token: 'a'.repeat(64), clientId: 'c1' },
      { t: 'create-session', cwd: '~/Projects', command: ['zsh', '-l'], cols: 120, rows: 40 },
      { t: 'attach', workspaceId: 'w1', cols: 80, rows: 24 },
      { t: 'resize', sessionId: 's1', cols: 200, rows: 60 },
      { t: 'auth-ok', serverVersion: '0.0.0', sessionCount: 3 },
      { t: 'session-exited', sessionId: 's1', exitCode: 0 },
      { t: 'error', code: 'session-expired', message: 'gone' },
    ];

    for (const message of messages) {
      const decoded = decodeFrame(controlFrame(message));
      expect(decoded.kind).toBe('control');
      if (decoded.kind !== 'control') throw new Error('unreachable');
      expect(decoded.message).toEqual(message);
    }
  });

  it('round-trips output and input frames byte for byte', () => {
    for (const size of [0, 1, 7, 4096, 65536]) {
      const data = bytes(size, size + 1);

      const out = decodeFrame(outputFrame(0, data));
      expect(out.kind).toBe('output');
      if (out.kind !== 'output') throw new Error('unreachable');
      expect(out.streamId).toBe(0);
      expect(Array.from(out.data)).toEqual(Array.from(data));

      const inp = decodeFrame(inputFrame(4294967295, data));
      if (inp.kind !== 'input') throw new Error('unreachable');
      expect(inp.streamId).toBe(4294967295);
      expect(Array.from(inp.data)).toEqual(Array.from(data));
    }
  });

  it('round-trips ack frames at the uint32 boundaries', () => {
    for (const [streamId, consumed] of [
      [0, 0],
      [1, 65536],
      [4294967295, 4294967295],
    ] as const) {
      const decoded = decodeFrame(ackFrame(streamId, consumed));
      if (decoded.kind !== 'ack') throw new Error('unreachable');
      expect(decoded.streamId).toBe(streamId);
      expect(decoded.bytesConsumed).toBe(consumed);
    }
  });

  it('preserves arbitrary bytes including nulls and invalid UTF-8', () => {
    // The whole reason terminal output is binary rather than JSON. A PTY emits arbitrary
    // bytes, and a lone continuation byte would be destroyed by a text round trip.
    const hostile = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x1b, 0x5b, 0x33, 0x31, 0x6d]);
    const decoded = decodeFrame(outputFrame(1, hostile));
    if (decoded.kind !== 'output') throw new Error('unreachable');
    expect(Array.from(decoded.data)).toEqual(Array.from(hostile));
  });

  it('does not alias the source buffer', () => {
    // A socket may reuse its read buffer. Decoded payloads must be independent copies.
    const frame = outputFrame(1, new Uint8Array([1, 2, 3]));
    const decoded = decodeFrame(frame);
    if (decoded.kind !== 'output') throw new Error('unreachable');
    frame.fill(0);
    expect(Array.from(decoded.data)).toEqual([1, 2, 3]);
  });

  it('round-trips through a subarray view of a larger buffer', () => {
    // Socket reads commonly hand back a view into a pooled buffer, not a standalone array.
    const encoded = ackFrame(7, 999);
    const pool = new Uint8Array(encoded.length + 16);
    pool.set(encoded, 8);
    const decoded = decodeFrame(pool.subarray(8, 8 + encoded.length));
    if (decoded.kind !== 'ack') throw new Error('unreachable');
    expect(decoded.streamId).toBe(7);
    expect(decoded.bytesConsumed).toBe(999);
  });
});

describe('frame codec rejects malformed input', () => {
  it('rejects an empty frame', () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrowError(ProtocolError);
  });

  it('rejects an unknown frame type', () => {
    expect(() => decodeFrame(new Uint8Array([0x7f, 0, 0, 0, 0]))).toThrowError(
      expect.objectContaining({ code: 'frame-unknown-type' }) as Error,
    );
  });

  it('rejects a truncated stream header', () => {
    expect(() => decodeFrame(new Uint8Array([FrameType.Output, 0, 0]))).toThrowError(
      expect.objectContaining({ code: 'frame-truncated' }) as Error,
    );
  });

  it('rejects a truncated ack', () => {
    expect(() => decodeFrame(new Uint8Array([FrameType.Ack, 0, 0, 0, 1, 0]))).toThrowError(
      expect.objectContaining({ code: 'frame-truncated' }) as Error,
    );
  });

  it('rejects a control frame that is not JSON', () => {
    expect(() => decodeFrame(new Uint8Array([FrameType.Control, 0x7b, 0x7b]))).toThrowError(
      expect.objectContaining({ code: 'control-not-json' }) as Error,
    );
  });

  it('rejects a control frame that is not an object', () => {
    for (const payload of ['[]', '"str"', '42', 'null']) {
      const body = new TextEncoder().encode(payload);
      const frame = new Uint8Array(1 + body.length);
      frame[0] = FrameType.Control;
      frame.set(body, 1);
      expect(() => decodeFrame(frame)).toThrowError(ProtocolError);
    }
  });

  it('rejects a control message with no type discriminator', () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const frame = new Uint8Array(1 + body.length);
    frame[0] = FrameType.Control;
    frame.set(body, 1);
    expect(() => decodeFrame(frame)).toThrowError(
      expect.objectContaining({ code: 'control-missing-type' }) as Error,
    );
  });

  it('rejects an oversized frame before use', () => {
    expect(() => decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: 'frame-too-large' }) as Error,
    );
  });

  it('rejects out-of-range identifiers at encode time', () => {
    const cases: Frame[] = [
      { kind: 'output', streamId: -1, data: new Uint8Array(0) },
      { kind: 'output', streamId: 4294967296, data: new Uint8Array(0) },
      { kind: 'output', streamId: 1.5, data: new Uint8Array(0) },
      { kind: 'ack', streamId: 0, bytesConsumed: -1 },
    ];
    for (const frame of cases) {
      expect(() => encodeFrame(frame)).toThrowError(
        expect.objectContaining({ code: 'value-out-of-range' }) as Error,
      );
    }
  });
});
