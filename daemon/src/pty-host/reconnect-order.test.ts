import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { PtyHostClient } from './client.js';
import { initLog } from '../log.js';

/**
 * What a daemon sees on the socket after it comes back, and in what order.
 *
 * The host adds a socket to its broadcast set the moment it connects, before any handshake, so a
 * reconnecting daemon starts receiving **live** output immediately. It then asks separately for
 * the range it missed. Those are two streams down one socket with nothing sequencing them: live
 * bytes from after the break can arrive before the replay of bytes from during it.
 *
 * Output frames carry an authoritative per-session sequence, which is what makes this detectable
 * at all. Whether anything downstream can act on it is the other half of the problem, and is
 * checked in `HostPtyBackend`.
 */
let dir = '';
let host: PtyHost;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-reorder-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'));
  await host.listen();
});

afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

async function connectClient(): Promise<PtyHostClient> {
  const client = new PtyHostClient({
    socketPath: join(dir, 'sock'),
    hostScript: join(dir, 'never-spawned'),
  });
  await client.connect(4000);
  /**
   * A connection catches up before it goes live, and saying so is the daemon's job.
   *
   * Done immediately here for the connections that have nothing to catch up on, which is what
   * adoption does when there is no history to ask for. The one connection in this file that does
   * have a gap says so after its replay, which is the whole point of the test.
   */
  client.reconciled();
  return client;
}

/** Wait for a marker to appear in what a collector has seen, or give up. */
/** A connection that has not yet said it caught up, which is a daemon mid-adoption. */
async function connectClientHoldingBack(): Promise<PtyHostClient> {
  const client = new PtyHostClient({
    socketPath: join(dir, 'sock'),
    hostScript: join(dir, 'never-spawned'),
  });
  await client.connect(4000);
  return client;
}

async function until(has: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (has()) return;
    await sleep(15);
  }
  throw new Error('marker never arrived');
}

describe('a daemon that comes back to a session that kept running', () => {
  it('is given live output and replayed output with nothing ordering them', async () => {
    const sessionId = 'reorder-1';

    /**
     * A second connection that never goes away, standing in for everything that keeps the session
     * producing while the daemon is absent: the program itself, a build, an agent. The host allows
     * several clients, and only one of them is the daemon under test.
     */
    const writer = await connectClient();
    writer.spawn({ sessionId, shell: '/bin/sh', cwd: dir, env: {}, cols: 80, rows: 24 });
    await sleep(300);

    const first = await connectClient();
    let seenFirst = '';
    let consumedThrough = 0;
    first.onData((_id, data, seq) => {
      seenFirst += data.toString('utf8');
      consumedThrough = Math.max(consumedThrough, seq);
    });
    writer.write(sessionId, 'echo BEFORE-BREAK\n');
    await until(() => seenFirst.includes('BEFORE-BREAK'));

    /**
     * Snapshotted at the break, not read afterwards.
     *
     * `PtyHostClient` reconnects on its own, so a closed client comes back and keeps consuming.
     * Reading the counter later therefore reports the latest sequence rather than the one the
     * daemon had reached when it went away, and a replay from there asks for nothing at all.
     */
    const consumedAtBreak = consumedThrough;

    // The daemon's socket goes. The session does not.
    first.close();
    await sleep(150);

    // Produced while nobody was listening. This is what a replay exists to deliver.
    writer.write(sessionId, 'echo DURING-BREAK\n');
    await sleep(400);

    // The daemon comes back, and the host starts broadcasting to it at once.
    const second = await connectClientHoldingBack();
    const order: number[] = [];
    let text = '';
    second.onData((_id, data, seq) => {
      order.push(seq);
      text += data.toString('utf8');
    });

    /**
     * Live output from after the reconnection, reaching the socket before anything was asked for.
     *
     * Waited for on the wire rather than in the stream: while the daemon is catching up this is
     * deliberately not handed on yet, so waiting for it to appear would wait for ever. That it
     * does not appear here is half of what this test is about.
     */
    writer.write(sessionId, 'echo AFTER-RECONNECT\n');
    await sleep(600);
    expect(text, 'live output must not be handed on before catch-up').not.toContain(
      'AFTER-RECONNECT',
    );

    // Only now does the daemon ask for what it missed, which is what `main` does after adopting,
    // and then says it has caught up.
    await second.replay(sessionId, consumedAtBreak);
    second.reconciled();
    await sleep(300);
    second.close();
    writer.close();

    const ascending = order.every((seq, i) => i === 0 || seq > (order[i - 1] ?? 0));
    expect(text, 'the gap must be delivered').toContain('DURING-BREAK');
    expect(text, 'and the live output after it').toContain('AFTER-RECONNECT');
    expect(
      text.indexOf('DURING-BREAK') < text.indexOf('AFTER-RECONNECT'),
      'and in that order, which is what a screen is',
    ).toBe(true);
    expect(new Set(order).size, 'no sequence delivered twice').toBe(order.length);
    expect(
      ascending,
      `sequence numbers arrived out of order: ${JSON.stringify(order.slice(0, 14))}`,
    ).toBe(true);
  }, 30000);
});
