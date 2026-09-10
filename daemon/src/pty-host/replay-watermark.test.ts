import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { PtyHostClient } from './client.js';
import { HostPtyBackend } from './backend.js';
import { VtState } from '../vt-state.js';
import { initLog } from '../log.js';

/**
 * Which number a reconnecting daemon asks the host to replay from.
 *
 * The host's ring is indexed by its own sequence, so the watermark has to be the host's sequence
 * for the last byte this daemon was given. The daemon holds other counters that look like it and
 * are not: `vt.seq` counts everything written into the emulator, and the daemon writes into it
 * itself. A session running a declared command gets an exit notice put into its own screen, and
 * that alone makes `vt.seq` larger than any number the host ever counted.
 *
 * Asking at a number that is too large skips real output and never says so, because the host can
 * always serve from a sequence past its own end: there is simply nothing there.
 */
let dir = '';
let host: PtyHost;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-watermark-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'));
  await host.listen();
});

afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

async function connect(): Promise<PtyHostClient> {
  const client = new PtyHostClient({
    socketPath: join(dir, 'sock'),
    hostScript: join(dir, 'never-spawned'),
  });
  await client.connect(4000);
  client.reconciled();
  return client;
}

async function until(has: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (has()) return;
    await sleep(15);
  }
  throw new Error('never arrived');
}

describe('the watermark a reconnect replays from', () => {
  it('is the host sequence, which the emulator count is not once the daemon writes anything', async () => {
    const sessionId = 'watermark-1';
    const client = await connect();
    let delivered = 0;
    const vt = new VtState(80, 24, 100);
    client.onData((id, data, seq) => {
      if (id !== sessionId) return;
      delivered = seq;
      vt.write(data);
    });

    client.spawn({ sessionId, shell: '/bin/sh', cwd: dir, env: {}, cols: 80, rows: 24 });
    client.write(sessionId, 'printf HOSTBYTES\n');
    await until(() => delivered > 0);
    await sleep(200);

    // The two agree while every byte in the emulator came from the host.
    expect(vt.seq).toBe(delivered);

    /*
     * Now the daemon writes into the session's own screen, which is what it does when a declared
     * command finishes. Nothing about the host changed.
     */
    vt.write(Buffer.from('\r\n\x1b[2m[exited 0]\x1b[0m\r\n', 'utf8'));

    expect(vt.seq).toBeGreaterThan(delivered);
    expect(client.deliveredThrough(sessionId)).toBe(delivered);

    client.close();
  });

  it('asks the backend at the host sequence and not at the emulator count', async () => {
    const sessionId = 'watermark-2';
    const writer = await connect();
    writer.spawn({ sessionId, shell: '/bin/sh', cwd: dir, env: {}, cols: 80, rows: 24 });
    writer.write(sessionId, 'printf FIRST\n');
    await sleep(300);

    const client = new PtyHostClient({
      socketPath: join(dir, 'sock'),
      hostScript: join(dir, 'never-spawned'),
    });
    await client.connect(4000);
    const backend = new HostPtyBackend(client);
    let seen = '';
    backend.onData((id, data) => {
      if (id === sessionId) seen += data.toString('utf8');
    });
    client.reconciled();

    // Everything the session produced before this daemon existed.
    const { missingBytes } = await backend.catchUp(sessionId);
    await until(() => seen.includes('FIRST'));

    expect(missingBytes).toBe(0);
    expect(backend.deliveredThrough(sessionId)).toBeGreaterThan(0);

    backend.close();
    writer.close();
  });
});
