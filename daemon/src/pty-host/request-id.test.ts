import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initLog } from '../log.js';
import { PtyHostClient } from './client.js';
import { PtyHost } from './host.js';

/**
 * An answer has to name the question it answers.
 *
 * Replies were matched by their type alone, which is correct only while at most one request of
 * each type is outstanding. A daemon adopting several sessions issues a `replay` for each of them
 * at once, and the second overwrote the first: one call never resolved and timed out, and the
 * other took whichever answer arrived first, which could be another session's screen.
 *
 * `kill` already carried a request id, because getting that one wrong ends the wrong terminal.
 * The rest now do too, because getting those wrong hands back the wrong screen.
 */

let dir = '';
let host: PtyHost;
let client: PtyHostClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-reqid-'));
  host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'), 8);
  await host.listen();
  client = new PtyHostClient({ socketPath: join(dir, 'sock'), hostScript: join(dir, 'never') });
  await client.connect(4000);
  // Standing in for a daemon, which says when it has finished catching up. Until it does, the
  // client holds live output rather than handing it on, so that a replay cannot arrive behind
  // bytes that came after it. See `reconnect-order.test.ts`.
  client.reconciled();
});

afterAll(async () => {
  client.close();
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('two requests of the same kind, at once', () => {
  it('each gets its own answer, for its own session', async () => {
    for (const id of ['reqid-a', 'reqid-b']) {
      client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    }
    await sleep(900);
    client.write('reqid-a', 'echo AAAA\r');
    client.write('reqid-b', 'echo BBBB\r');
    await sleep(1200);

    // Issued together, without waiting for the first, which is what adoption does.
    const [a, b] = await Promise.all([client.replay('reqid-a', 0), client.replay('reqid-b', 0)]);

    // Both resolved. Under the old matching one of these was null, having timed out.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    await client.killAndWait('reqid-a', false, 4000);
    await client.killAndWait('reqid-b', false, 4000);
  });

  it('and many at once all resolve', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    for (const id of ids) {
      client.spawn({ sessionId: id, shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    }
    await sleep(1000);

    const answers = await Promise.all(ids.map((id) => client.replay(id, 0)));
    expect(answers.filter((x) => x !== null)).toHaveLength(ids.length);

    for (const id of ids) await client.killAndWait(id, false, 4000);
  });

  it('and a list issued beside a replay does not take its answer', async () => {
    // Different types, so this was already safe. Kept because the mechanism now routes both, and
    // a change that broke it would otherwise only show up under concurrency of the same type.
    client.spawn({ sessionId: 'mix', shell: '/bin/zsh', cwd: dir, cols: 80, rows: 24, env: {} });
    await sleep(900);

    const [sessions, replayed] = await Promise.all([client.list(), client.replay('mix', 0)]);
    expect(sessions.some((s) => s.sessionId === 'mix')).toBe(true);
    expect(replayed).not.toBeNull();

    await client.killAndWait('mix', false, 4000);
  });
});

/**
 * And the pairing itself, which the concurrency tests above cannot see.
 *
 * They prove both calls resolve, which is the failure that used to happen: the single-slot map
 * was overwritten and one call timed out. They cannot prove the answers went to the right
 * callers, because `replay` reports a byte count and two sessions can honestly report the same
 * one. What makes the pairing exact is that the request carries an id and the answer returns it,
 * so that is asserted where it is visible.
 */
describe('the mechanism that makes the pairing exact', () => {
  it('sends an id with every request and prefers it when matching', () => {
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
    // The outgoing message carries one.
    expect(source).toMatch(
      /const withId = \{ \.\.\.\(message as Record<string, unknown>\), requestId \}/,
    );
    // And an incoming reply is matched by it first, falling back to type only when absent.
    expect(source).toMatch(/msg\['requestId'\] === 'string'/);
    expect(source).toMatch(/this\.#waiting\.has\(id\)/);
  });

  it('and the host returns the id it was given, or nothing when given none', () => {
    /**
     * The fallback is not decoration. A host outlives the daemon by design, so one built before
     * this change is a real thing to meet: it echoes nothing, and matching by type is exactly
     * what both sides did before.
     */
    const source = readFileSync(new URL('./host.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/function echo\(msg: Record<string, unknown>\)/);
    expect(source).toMatch(
      /typeof msg\['requestId'\] === 'string' \? \{ requestId: msg\['requestId'\] \} : \{\}/,
    );
    // Every reply that answers a request carries it.
    for (const reply of ['hello-ok', 'sessions', 'replayed', 'history-end']) {
      const at = source.indexOf(`t: '${reply}'`);
      expect(at).toBeGreaterThan(0);
      expect(source.slice(at, at + 200)).toContain('echo(msg)');
    }
  });
});
