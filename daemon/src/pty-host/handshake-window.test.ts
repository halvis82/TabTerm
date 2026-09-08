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
 * Nothing that names a session reaches a host that has not said who it is.
 *
 * The outbox was already held until `hello` came back, but a socket existing was enough for any
 * **new** message to be written straight to it. Between connecting and being identified there is
 * a window, short and real, in which a spawn, a write, a resize or a kill goes to whichever
 * process answered. After a host has been replaced that is a different process holding different
 * sessions, and one of those messages can be a kill.
 *
 * So this holds the `hello-ok` back on purpose, does every ordinary thing during the gap, and
 * counts what arrived.
 */

let server: Server;
let dir = '';
let socketPath = '';
/** Everything the fake host received, in order, as decoded control messages. */
let received: Record<string, unknown>[] = [];
/** Released to let the handshake finish. */
let answerHello: (() => void) | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  initLog('error');
  received = [];
  answerHello = null;
  dir = mkdtempSync(join(tmpdir(), 'tt-handshake-'));
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
        received.push(msg);
        if (msg['t'] === 'hello') {
          // Held, so the window this test is about stays open until it is released.
          answerHello = () => {
            socket.write(
              controlFrame({
                t: 'hello-ok',
                protocol: HOST_PROTOCOL,
                pid: process.pid,
                instance: 'fake-host-instance',
              }),
            );
          };
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

/** Everything received that is about a particular session rather than about the connection. */
const sessionTargeted = () => received.filter((m) => m['t'] !== 'hello');

describe('the window between connecting and being identified', () => {
  it('lets nothing that names a session through it', async () => {
    const client = new PtyHostClient({ socketPath, hostScript: '/nonexistent' });
    const connecting = client.connect(3000);
    // Wait until the host has the hello and is deliberately sitting on it.
    for (let i = 0; i < 50 && answerHello === null; i++) await sleep(20);
    expect(answerHello, 'the handshake must be in flight for this to test anything').toBeTruthy();

    // Everything an ordinary daemon does, during the gap.
    client.spawn({ sessionId: 's-1', cwd: '/tmp', shell: '/bin/zsh', cols: 80, rows: 24 });
    client.write('s-1', 'echo hello\r');
    client.inject('s-1', 'banner');
    client.resize('s-1', 100, 40);
    const killed = await client.killAndWait('s-1', false, 200);

    await sleep(150);
    expect(sessionTargeted(), 'nothing may reach an unidentified host').toEqual([]);
    /**
     * And the kill says it did not happen, rather than waiting to.
     *
     * A queued kill is aimed at a process that may be gone by the time anything is flushed. The
     * caller reads false as "this did not happen", which is what keeps the session's record.
     */
    expect(killed, 'a kill during the handshake is unconfirmed, not queued').toBe(false);

    // Released. The connection becomes usable and what was held goes, in order.
    answerHello?.();
    await connecting;
    await sleep(200);

    const after = sessionTargeted().map((m) => m['t']);
    expect(after, 'and then everything held arrives, in the order it was asked for').toEqual([
      'spawn',
      'write',
      'inject',
      'resize',
    ]);
    // The kill is not among them: it was refused rather than held.
    expect(after).not.toContain('kill');
    client.close();
  });

  it('sends the handshake itself, since nothing else can identify the host', async () => {
    const client = new PtyHostClient({ socketPath, hostScript: '/nonexistent' });
    const connecting = client.connect(3000);
    for (let i = 0; i < 50 && answerHello === null; i++) await sleep(20);
    expect(received.map((m) => m['t'])).toEqual(['hello']);
    answerHello?.();
    expect(await connecting).toBe(true);
    client.close();
  });
});
