import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { PtyHostClient } from './client.js';

/**
 * The last line of defence against taking the machine's terminals down.
 *
 * macOS hands out a fixed number of pseudo-terminals and running out does not degrade this
 * product, it stops every terminal in every application with an opaque `posix_spawnp failed`.
 * This process is the only place that can hold the line, because it is the only one that knows
 * the total: the daemon can be replaced and Chrome can be closed while these keep running.
 *
 * Three sessions here rather than a hundred. What is being checked is that the limit is enforced
 * and that refusing says something a person can act on, and neither of those needs the real
 * number. Opening a hundred shells to prove a limit about opening too many shells would be a
 * test that occasionally breaks the machine it runs on.
 */
let dir = '';
let host: PtyHost;
let client: PtyHostClient;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-cap-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'), 3);
  await host.listen();
  client = new PtyHostClient({ socketPath: join(dir, 'sock'), hostScript: join(dir, 'never') });
  await client.connect(4000);
});

afterAll(async () => {
  client.close();
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the number of sessions one host will hold', () => {
  it('refuses the one past the limit, and says why in the pane', async () => {
    const output: string[] = [];
    const exits: string[] = [];
    client.onData((_id, data) => output.push(data.toString('utf8')));
    client.onExit((id) => exits.push(id));

    for (const n of [1, 2, 3]) {
      client.spawn({
        sessionId: `under-the-cap-${String(n)}`,
        shell: '/bin/zsh',
        cwd: dir,
        cols: 80,
        rows: 24,
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(host.sessionCount).toBe(3);

    client.spawn({
      sessionId: 'over-the-cap',
      shell: '/bin/zsh',
      cwd: dir,
      cols: 80,
      rows: 24,
    });
    await new Promise((r) => setTimeout(r, 800));

    // Still three: the refusal is a refusal, not a delay.
    expect(host.sessionCount).toBe(3);
    // And the pane says what happened, rather than showing an exit code and nothing else.
    const said = output.join('');
    expect(said).toContain('3 terminals are already running');
    expect(said).toContain('macOS');
    expect(exits).toContain('over-the-cap');
  });
});

/**
 * A host that holds nothing for nobody leaves.
 *
 * This process exists to outlive its daemon, which is exactly why it cannot be ended along with
 * one. That is right while it holds terminals and pointless when it holds none: an interrupted
 * test run left one behind every time, and 133 of them were found on one machine, holding
 * 797 MB between them.
 *
 * Both conditions matter. A daemon being replaced disconnects and reconnects within seconds, and
 * a host that left in that gap would take every terminal with it.
 */
describe('a host with nothing left to hold', () => {
  it('leaves once its last client has gone, and not before', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tt-idle-'));
    let left = false;
    const idle = new PtyHost(join(home, 'sock'), join(home, 'scrollback'), 3, () => {
      left = true;
    });
    await idle.listen();

    const talker = new PtyHostClient({
      socketPath: join(home, 'sock'),
      hostScript: join(home, 'never'),
    });
    await talker.connect(4000);
    expect(left, 'a host somebody is talking to stays').toBe(false);

    talker.close();
    await new Promise((r) => setTimeout(r, 300));
    // Scheduled rather than immediate: the delay is what makes a daemon restart survivable.
    expect(left, 'and it waits rather than going the instant the socket drops').toBe(false);

    await idle.close();
    await rm(home, { recursive: true, force: true });
  });
});
