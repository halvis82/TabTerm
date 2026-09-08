import { readdirSync, readFileSync } from 'node:fs';
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

/** What the host has kept on disk for a session, or nothing at all. */
const onDisk = (sessionId: string): string => {
  const under = join(dir, 'scrollback');
  try {
    for (const name of readdirSync(under)) {
      if (!name.includes(sessionId)) continue;
      return readFileSync(join(under, name), 'utf8');
    }
  } catch {
    /* no directory yet is the same as nothing kept */
  }
  return '';
};

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

/**
 * And the other fact that has to outlive the daemon: a person closed this session's pane.
 *
 * It is the only thing that authorizes ending a session that is in no workspace, and closing a
 * pane is exactly what puts a session there: it stays alive in its undo window and leaves the
 * layout, and if the tab is then closed the workspace goes too. A restart lost the flag, so the
 * session came back with nothing saying why it was allowed to go, and was kept forever. Reported
 * as a session in Running Now that could be neither opened nor got rid of.
 */
describe('a session whose pane a person closed', () => {
  it('is remembered as such, and the daemon can be replaced in between', async () => {
    const id = 'closed-1';
    client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);

    expect((await listed(id))?.paneClosedByUser).toBeUndefined();

    client.markPaneClosed(id);
    await sleep(300);

    expect((await listed(id))?.paneClosedByUser).toBe(true);
    await client.killAndWait(id, false, 3000);
  });

  it('and the two facts are independent of each other', async () => {
    // Typing into a terminal is not closing its pane, and closing a pane is not typing.
    const id = 'closed-2';
    client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);
    client.markPaneClosed(id);
    await sleep(300);
    const seen = await listed(id);
    expect(seen?.paneClosedByUser).toBe(true);
    expect(seen?.hasInput).toBeUndefined();
    await client.killAndWait(id, false, 3000);
  });
});

/**
 * A failed attempt to end a terminal must not erase the record of it.
 *
 * The history is what a tab still showing that terminal has left, and it is the only way back to
 * a process that survived. It was cleared synchronously, before the kill was known to have
 * worked, so an unconfirmed kill destroyed the recovery information for a terminal that was still
 * running.
 */
describe('history and the kill that may not have happened', () => {
  it('drops the history once the process is confirmed gone', async () => {
    const id = 'history-1';
    client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);
    client.write(id, 'echo REMEMBER-ME\r');
    await sleep(900);

    // On disk, which is what the history is. `history()` streams it back by callback rather
    // than returning it, and the question here is whether the file still exists at all.
    expect(onDisk(id)).toContain('REMEMBER-ME');

    expect(await client.killAndWait(id, false, 4000)).toBe(true);
    await sleep(400);
    expect(onDisk(id)).toBe('');
  });

  it('and keeps it when asked to, for a session nobody closed', async () => {
    // A timeout is not somebody closing a terminal, and its tab may still be open.
    const id = 'history-2';
    client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);
    client.write(id, 'echo KEEP-ME\r');
    await sleep(900);

    expect(await client.killAndWait(id, true, 4000)).toBe(true);
    await sleep(400);
    expect(onDisk(id)).toContain('KEEP-ME');
  });

  it('and never clears it before the answer is known', () => {
    /**
     * Checked at the source. Forcing a kill to go unconfirmed needs a process that refuses every
     * signal, and what matters is not one contrived case but that the clear cannot be reached
     * before the outcome is.
     */
    const source = readFileSync(new URL('./host.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/outcome === 'gone' && msg\['keepHistory'\] !== true/);
  });
});
