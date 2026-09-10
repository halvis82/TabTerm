import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { initLog } from '../log.js';

/**
 * The outcome the lock is supposed to prevent, prevented where it actually happens.
 *
 * A host taking the socket used to remove whatever was at the path, on the reasoning that the lock
 * guarantees two hosts cannot get there at once. It does not. Taking over a claim judged stale
 * means moving it aside to look at it, and for that moment the name is free, so a third contender
 * can take it while the second still believes it holds it. Both then arrive at `listen`, and the
 * second deletes the first's socket: every terminal on the machine unreachable at once.
 *
 * The lock is still not exclusive. This is the one consequence that must not follow from that, and
 * it is checked here rather than argued about there.
 */
let dir = '';

/** Whether anything accepts a connection at a path. */
const connectable = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      probe.destroy();
      resolve(false);
    });
  });

beforeEach(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-live-socket-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a second host meeting a socket that already exists', () => {
  it('refuses to start rather than take it from a host that is answering', async () => {
    const path = join(dir, 'sock');
    const first = new PtyHost(path, join(dir, 'scrollback-1'));
    await first.listen();

    const second = new PtyHost(path, join(dir, 'scrollback-2'));
    await expect(second.listen()).rejects.toThrow(/already listening/);

    // And the first one still has it, which is the whole point.
    expect(existsSync(path)).toBe(true);
    await first.close();
  });

  it('clears a socket a dead host left behind, which is what the removal is for', async () => {
    const path = join(dir, 'sock');
    const first = new PtyHost(path, join(dir, 'scrollback-1'));
    await first.listen();
    await first.close();

    // The file may survive its owner. Nothing answers on it, so it is not a host.
    const second = new PtyHost(path, join(dir, 'scrollback-2'));
    await second.listen();
    expect(existsSync(path)).toBe(true);
    await second.close();
  });
});

describe('two hosts finding the same stale socket', () => {
  it('leaves exactly one of them reachable, and neither destroys the other', async () => {
    /*
     * The narrower race under the one above. Removing a stale socket and binding the free name is
     * two operations, so two hosts that both find the same stale socket both remove it, and the
     * second removal deletes a socket the first has already bound and is already serving.
     *
     * Binding beside the name and renaming onto it makes that one operation. The loser of the
     * rename holds a socket nothing can reach, which is harmless: nobody connects to it.
     */
    const path = join(dir, 'sock');
    const first = new PtyHost(path, join(dir, 'scrollback-1'));
    await first.listen();
    await first.close();
    // A socket file left behind by a host that is gone, which is what both racers will find.

    const a = new PtyHost(path, join(dir, 'scrollback-a'));
    const b = new PtyHost(path, join(dir, 'scrollback-b'));
    await Promise.all([a.listen(), b.listen()]);

    // The name exists and answers, whichever of them ended up holding it.
    expect(existsSync(path)).toBe(true);
    await expect(connectable(path)).resolves.toBe(true);

    // And nothing was left staged behind either of them.
    const staged = (await readdir(dir)).filter((n) => n.includes('.binding'));
    expect(staged).toEqual([]);

    await a.close();
    await b.close();
  });
});
