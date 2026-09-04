import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PtyHost } from './host.js';
import { PtyHostClient } from './client.js';

/**
 * Everything above U+00FF has to survive the host.
 *
 * It did not. The host encoded node-pty's output with `'binary'`, which is Latin-1 and keeps
 * only the low byte of each code unit, so a box drawn with `╭─╮ │ ╰╯` arrived as `m`, nothing,
 * `n`, nothing, `p`, `o`: the low bytes of U+256D, U+2500, U+256E, U+2502, U+2570, U+256F. That
 * is not a subtle corruption, it is every terminal user interface drawing as gibberish, and it
 * was invisible for months because the local backend encodes correctly and that is the one the
 * browser suites were using.
 */
let dir = '';
let host: PtyHost;
let client: PtyHostClient;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-unicode-'));
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

describe('what the host hands back', () => {
  it('keeps box drawing, accents and emoji exactly as the program wrote them', async () => {
    const output: string[] = [];
    client.onData((_id, data) => output.push(data.toString('utf8')));

    // The characters from the report, plus an accent and an emoji, printed by a real shell.
    const wanted = '╭─╮│╰╯ ✻ café → 🚀';
    client.spawn({
      sessionId: 'unicode',
      shell: '/bin/zsh',
      cwd: dir,
      cols: 80,
      rows: 24,
      command: ['/bin/echo', wanted],
    });
    await new Promise((r) => setTimeout(r, 1800));

    const said = output.join('');
    expect(said).toContain(wanted);
    // The specific corruption, named so a regression is recognised rather than puzzled over.
    expect(said).not.toContain('mn');
    expect(said).not.toContain('po');
  }, 15000);
});
