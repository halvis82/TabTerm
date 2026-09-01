import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { PtyHostClient } from './client.js';

/**
 * A command that cannot start has to say so in the pane.
 *
 * This is the path that reported an exit code and nothing else, so a missing agent CLI and a
 * crash looked identical. The daemon runs with launchd's PATH, which is four system
 * directories, so "cannot start" was the normal outcome for every agent CLI on the machine.
 */
let dir = '';
let host: PtyHost;
let client: PtyHostClient;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-spawnfail-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'));
  await host.listen();
  client = new PtyHostClient({ socketPath: join(dir, 'sock'), hostScript: join(dir, 'never') });
  await client.connect(4000);
});

afterAll(async () => {
  client.close();
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a command that cannot be started', () => {
  it('writes a readable reason into the session, then exits', async () => {
    const output: string[] = [];
    const exits: number[] = [];
    client.onData((_id, data) => output.push(data.toString('utf8')));
    client.onExit((_id, code) => exits.push(code));

    client.spawn({
      sessionId: 'missing-command',
      shell: '/bin/zsh',
      cwd: dir,
      cols: 80,
      rows: 24,
      command: ['definitely-not-a-real-command-xyz'],
    });
    await new Promise((r) => setTimeout(r, 1500));

    const said = output.join('');
    expect(said).toContain('definitely-not-a-real-command-xyz');
    expect(said).toContain('TabTerm');
    // The exit still happens, so a pane that will never produce output does not sit there
    // looking like it is starting.
    expect(exits).toContain(1);
  });

  it('starts a command that does exist, found on the login shell PATH', async () => {
    const output: string[] = [];
    client.onData((_id, data) => output.push(data.toString('utf8')));
    client.spawn({
      sessionId: 'real-command',
      shell: '/bin/zsh',
      cwd: dir,
      cols: 80,
      rows: 24,
      command: ['echo', 'SPAWNED-OK'],
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(output.join('')).toContain('SPAWNED-OK');
  });
});

describe('a message the host cannot make sense of', () => {
  it('is answered and ignored, and everything else keeps working', async () => {
    // This process holds the only handle to everybody's running work, so unwinding out of a
    // socket handler over one bad message would risk far more than the message is worth.
    const output: string[] = [];
    client.onData((_id, data) => output.push(data.toString('utf8')));

    // A resize with nonsense in it, then an ordinary spawn.
    client.resize('nobody', Number.NaN, Number.NaN);
    client.spawn({
      sessionId: 'after-a-bad-message',
      shell: '/bin/zsh',
      cwd: dir,
      cols: 80,
      rows: 24,
      command: ['echo', 'STILL-WORKING'],
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(output.join('')).toContain('STILL-WORKING');
  });
});
