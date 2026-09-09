import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { PtyHostClient } from './client.js';
import { initLog } from '../log.js';

/**
 * A daemon that stops reading must not be able to grow the host's memory without bound.
 *
 * The PTY host is the single process holding every PTY master on the machine. Everything else can
 * be restarted; this cannot, without ending somebody's work. So of the three things that could
 * give when a consumer falls behind, only one is acceptable:
 *
 * - block the PTY, and a build stops because a browser is busy: no
 * - queue in the host without limit, and the process holding every terminal runs out of memory: no
 * - drop that transport, and let it reconnect and replay: yes
 *
 * The bounded ring and the replay protocol already exist for exactly this, which is what makes the
 * third option cheap.
 */
let dir = '';
let host: PtyHost;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-slow-'));
  // A small bound, so the behaviour at the bound can be observed in seconds. What is being
  // tested is what happens when it is crossed, not where it is.
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'), undefined, undefined, 512 * 1024);
  await host.listen();
});

afterEach(async () => {
  await host.close();
  // Retried once: a session that was pouring out output can still be flushing history as this
  // runs, and a directory that grew a file mid-removal is not a failure of anything being tested.
  await rm(dir, { recursive: true, force: true }).catch(async () => {
    await new Promise((r) => setTimeout(r, 250));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
});

describe('a daemon that has stopped reading', () => {
  it('is dropped rather than allowed to fill the host', async () => {
    // A real client, to own a session and keep reading normally.
    const worker = new PtyHostClient({
      socketPath: join(dir, 'sock'),
      hostScript: join(dir, 'never-spawned'),
    });
    await worker.connect(4000);
    worker.reconciled();

    /**
     * And a socket that connects, is subscribed to output like any other, and never reads a byte.
     *
     * Raw rather than a `PtyHostClient`, because the client reads eagerly and the whole point is a
     * peer that does not. `pause()` stops this end draining, so the bytes pile up in the host's
     * socket exactly as they would for a wedged daemon.
     */
    const stalled: Socket = connect(join(dir, 'sock'));
    await new Promise((r, j) => {
      stalled.on('connect', r);
      stalled.on('error', j);
    });
    stalled.pause();
    let dropped = false;
    stalled.on('close', () => {
      dropped = true;
    });
    // Being dropped arrives as a reset before it arrives as a close, and an unhandled `error` on a
    // socket throws. That is the event this test is waiting for, not a failure.
    stalled.on('error', () => {
      dropped = true;
    });

    const sessionId = 'flood';
    worker.spawn({ sessionId, shell: '/bin/sh', cwd: dir, env: {}, cols: 200, rows: 50 });
    await sleep(300);

    /**
     * Far more than any socket buffer will absorb, produced as fast as a shell can.
     *
     * `yes` rather than a loop: the point is to outrun the reader by a wide margin, and a loop
     * spawning two processes per line is slower than the socket it is trying to fill.
     */
    worker.write(sessionId, "yes $(head -c 400 /dev/zero | tr '\\0' 'x')\n");

    // Long enough for the queue to pass the bound, which takes a moment at this rate.
    await sleep(4000);

    /**
     * And now start reading again, which is the only way this end can find out.
     *
     * A paused socket does not observe the peer closing, because noticing requires a read. The
     * host dropped this connection while it was paused; resuming is what surfaces it here.
     */
    stalled.resume();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !dropped) await sleep(50);

    expect(dropped, 'a peer that never drains must be dropped, not buffered for ever').toBe(true);
    // And the thing that matters more: the host and the session are still there.
    expect(host.sessionCount, 'the terminal must survive the transport being dropped').toBe(1);

    // Stop the flood before tearing down, or the store is still writing while the directory is
    // being removed and the teardown fails for a reason that has nothing to do with the test.
    await worker.killAndWait(sessionId, false, 4000).catch(() => undefined);
    worker.close();
    await sleep(200);
  }, 40000);
});
