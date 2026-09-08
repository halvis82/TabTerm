import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostClient } from './client.js';
import { controlFrame, decodeFrames } from './framing.js';
import { HOST_PROTOCOL } from './host.js';
import { initLog } from '../log.js';

/**
 * An acknowledgement means the process is gone, and nothing weaker.
 *
 * The daemon discards its record of a session on the strength of this reply. A reply that means
 * "termination was begun" therefore lets it forget a process that is still running, and a process
 * nothing can see, reach or end is a worse outcome than one lingering in a list.
 *
 * A real host is not needed to pin the contract. What is needed is a host that answers in each of
 * the ways a real one can, including the ways an old or broken one does.
 */

let server: Server;
let dir = '';
let socketPath = '';
/** How the fake host answers the next kill. */
let reply: 'gone' | 'survived' | 'silent' | 'no-field' = 'gone';
/** How long it sits on the request before answering, so "not yet" can be observed. */
let answerAfterMs = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  initLog('error');
  reply = 'gone';
  answerAfterMs = 0;
  dir = mkdtempSync(join(tmpdir(), 'tt-killack-'));
  socketPath = join(dir, 'host.sock');

  server = createServer((socket: Socket) => {
    let pending = new Uint8Array(0);
    socket.on('data', (chunk: Buffer) => {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      const decoded = decodeFrames(merged);
      pending = merged.subarray(decoded.consumed);
      for (const frame of decoded.frames) {
        if (frame.kind !== 'control') continue;
        const msg = frame.message as Record<string, unknown>;
        if (msg['t'] === 'hello') {
          socket.write(
            controlFrame({
              t: 'hello-ok',
              protocol: HOST_PROTOCOL,
              pid: process.pid,
              instance: 'ack-test-host',
            }),
          );
        }
        if (msg['t'] === 'kill' && reply !== 'silent') {
          const answer = {
            t: 'killed',
            requestId: msg['requestId'],
            sessionId: msg['sessionId'],
            existed: true,
            ...(reply === 'no-field' ? {} : { gone: reply === 'gone' }),
          };
          setTimeout(() => socket.write(controlFrame(answer)), answerAfterMs);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function connected(): Promise<PtyHostClient> {
  const client = new PtyHostClient({ socketPath, hostScript: '/nonexistent' });
  expect(await client.connect(3000)).toBe(true);
  return client;
}

describe('what a kill acknowledgement is allowed to mean', () => {
  it('confirms only when the host says the process is gone', async () => {
    const client = await connected();
    expect(await client.killAndWait('s-1')).toBe(true);
    client.close();
  });

  it('does not confirm when the host says the process survived', async () => {
    reply = 'survived';
    const client = await connected();
    expect(await client.killAndWait('s-1')).toBe(false);
    client.close();
  });

  it('does not confirm when nothing answers at all', async () => {
    reply = 'silent';
    const client = await connected();
    expect(await client.killAndWait('s-1', false, 300)).toBe(false);
    client.close();
  });

  it('does not confirm on an answer from a host too old to say', async () => {
    // A missing field is not a yes. Reading absence as success is the same mistake as reading a
    // queued frame as one.
    reply = 'no-field';
    const client = await connected();
    expect(await client.killAndWait('s-1', false, 500)).toBe(false);
    client.close();
  });

  it('does not resolve before the answer arrives', async () => {
    answerAfterMs = 400;
    const client = await connected();
    let settled = false;
    const pending = client.killAndWait('s-1', false, 3000).then((v) => {
      settled = true;
      return v;
    });
    await sleep(150);
    expect(settled, 'the wait must outlast the host taking its time').toBe(false);
    expect(await pending).toBe(true);
    client.close();
  });

  it('is not confirmed twice by a late or duplicate answer', async () => {
    const client = await connected();
    expect(await client.killAndWait('s-1')).toBe(true);
    // The same answer again, after the wait has been settled and forgotten.
    await sleep(100);
    expect(await client.killAndWait('s-2')).toBe(true);
    client.close();
  });
});
