import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initLog } from '../log.js';
import { PtyHostClient } from './client.js';
import { PtyHost } from './host.js';

/**
 * Whether anybody has typed into a terminal, remembered where it lasts as long as the terminal.
 *
 * The fact decides whether a tab may go back to the start screen, and it cannot be read from the
 * screen: a half-typed command sits on the prompt line and leaves the line count at one, exactly
 * like a prompt nobody has touched, and nothing was run so the output says nothing either.
 *
 * The daemon knows it while it runs and forgets it on every restart, which happens on every
 * update, so a terminal somebody had typed into looked untouched again afterwards. This process
 * outlives the daemon and dies with the terminals it holds, which is what makes it the right
 * place: the fact is exactly as durable as the thing it is about.
 */

let dir = '';
let host: PtyHost;
let client: PtyHostClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listed = async (id: string) => (await client.list()).find((s) => s.sessionId === id);

beforeAll(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-typed-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'), 8);
  await host.listen();
  client = new PtyHostClient({ socketPath: join(dir, 'sock'), hostScript: join(dir, 'never') });
  await client.connect(4000);
});

afterAll(async () => {
  client.close();
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a terminal somebody has typed into', () => {
  it('is reported as untouched until somebody types, and as typed into afterwards', async () => {
    const id = 'typed-1';
    client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);

    expect((await listed(id))?.hasInput).toBeUndefined();

    // Not a command. Three characters and no Return, which is the case nothing else can see.
    client.write(id, 'ech');
    await sleep(300);

    expect((await listed(id))?.hasInput).toBe(true);
    await client.killAndWait(id, false, 3000);
  });

  it('and stays typed into, since a session somebody has used stays used', async () => {
    const id = 'typed-2';
    client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);
    client.write(id, 'x');
    await sleep(200);
    // Whatever arrives later, including output and resizes, must not clear it.
    client.resize(id, 100, 40);
    await sleep(300);
    expect((await listed(id))?.hasInput).toBe(true);
    await client.killAndWait(id, false, 3000);
  });
});
