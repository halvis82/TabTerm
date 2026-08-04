import { describe, expect, it, vi } from 'vitest';
import { FlowController } from './flow-control.js';

function makeFc(o: {
  windowBytes?: number;
  coalesceMs?: number;
  maxChunkBytes?: number;
  send?: (b: Buffer) => void;
  onDesync?: () => void;
}) {
  const sent: Buffer[] = [];
  const desync = vi.fn();
  const fc = new FlowController({
    windowBytes: o.windowBytes ?? 1024,
    coalesceMs: o.coalesceMs ?? 1,
    maxChunkBytes: o.maxChunkBytes ?? 256,
    send: o.send ?? ((b) => sent.push(b)),
    onDesync: o.onDesync ?? desync,
  });
  return { fc, sent, desync };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('flow control', () => {
  it('coalesces many small writes into fewer, larger frames', async () => {
    const { fc, sent } = makeFc({});
    for (let i = 0; i < 100; i++) fc.push(Buffer.alloc(4, 0x41));
    await tick();
    expect(sent.length).toBeLessThan(10);
    expect(Buffer.concat(sent).length).toBe(400);
  });

  it('never emits a chunk larger than maxChunkBytes', async () => {
    const { fc, sent } = makeFc({ maxChunkBytes: 64, windowBytes: 4096 });
    fc.push(Buffer.alloc(1000, 0x42));
    await tick();
    for (const s of sent) expect(s.length).toBeLessThanOrEqual(64);
  });

  it('stops sending once the window is exhausted and resumes on ack', async () => {
    const { fc, sent } = makeFc({ windowBytes: 256, maxChunkBytes: 128 });
    fc.push(Buffer.alloc(800, 0x43));
    await tick();
    const beforeAck = Buffer.concat(sent).length;
    expect(beforeAck).toBeLessThanOrEqual(256);

    fc.ack(beforeAck);
    await tick();
    expect(Buffer.concat(sent).length).toBeGreaterThan(beforeAck);
  });

  it('desyncs when a client stops acking and the backlog grows past the threshold', async () => {
    const { fc, desync } = makeFc({ windowBytes: 256, maxChunkBytes: 128 });
    // Fill the window first so the client counts as behind, then keep producing without acks.
    for (let i = 0; i < 200; i++) {
      fc.push(Buffer.alloc(64, 0x44));
      if (i === 8) await tick(); // let the first flush fill the outstanding window
    }
    await tick();
    expect(desync).toHaveBeenCalled();
  });

  it('does NOT desync on one large write when the client is keeping up', async () => {
    const { fc, sent, desync } = makeFc({ windowBytes: 4096, maxChunkBytes: 512 });
    fc.push(Buffer.alloc(64 * 1024, 0x46));
    for (let i = 0; i < 40; i++) {
      await tick(2);
      fc.ack(4096); // a healthy client draining as fast as it receives
    }
    expect(desync).not.toHaveBeenCalled();
    expect(Buffer.concat(sent).length).toBeGreaterThan(16 * 1024);
  });

  it('preserves byte order and content exactly', async () => {
    const { fc, sent } = makeFc({ windowBytes: 1 << 20, maxChunkBytes: 7 });
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog, twice over');
    for (const byte of payload) fc.push(Buffer.from([byte]));
    await tick(20);
    fc.ack(1 << 20);
    await tick(20);
    expect(Buffer.concat(sent).toString()).toBe(payload.toString());
  });

  it('drops queued output after a desync and resumes cleanly on resync', async () => {
    const { fc, sent } = makeFc({ windowBytes: 128 });
    for (let i = 0; i < 100; i++) fc.push(Buffer.alloc(64, 0x45));
    await tick();
    sent.length = 0;
    fc.resync();
    fc.push(Buffer.from('after'));
    await tick();
    expect(Buffer.concat(sent).toString()).toBe('after');
  });
});
