import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeStoreDir, encodeStoreDir, listResumable } from './agent-sessions.js';

describe('mapping a store directory to a real path', () => {
  it('encodes a path the way the store names its directories', () => {
    expect(encodeStoreDir('/Users/me/code/app')).toBe('-Users-me-code-app');
  });

  it('flattens the characters the store also flattens', () => {
    // Underscores and dots become hyphens too, which is exactly why the encoding cannot be
    // reversed and why known directories are encoded forward instead.
    expect(encodeStoreDir('/Users/me/personal_coding/my.app')).toBe(
      '-Users-me-personal-coding-my-app',
    );
  });

  it('maps different real paths onto the same store name', () => {
    // The ambiguity is real and unavoidable. Guessing at it would attach a resume to the
    // wrong project, which is worse than offering nothing.
    expect(encodeStoreDir('/a/b_c')).toBe(encodeStoreDir('/a/b-c'));
  });

  it('offers decode candidates only as a fallback, always most-separators first', () => {
    const candidates = decodeStoreDir('-Users-me-code');
    expect(candidates[0]).toBe('/Users/me/code');
    expect(candidates.length).toBeLessThanOrEqual(12);
  });

  it('ignores a directory name that is not in the store format', () => {
    // Store directories always start with the leading separator's hyphen.
    expect(decodeStoreDir('plain')).toEqual([]);
    expect(decodeStoreDir('not-a-store-dir')).toEqual([]);
  });
});

describe('listing resumable sessions', () => {
  it('returns nothing rather than throwing when the store is absent', async () => {
    // Someone who has never run the agent CLI must get a working launcher with no chips.
    const found = await listResumable({ cwd: '/definitely/not/a/real/path', limit: 5 });
    expect(Array.isArray(found)).toBe(true);
    expect(found).toEqual([]);
  });

  it('honors the limit', async () => {
    expect((await listResumable({ limit: 2 })).length).toBeLessThanOrEqual(2);
  });

  it('returns newest first', async () => {
    const found = await listResumable({ limit: 6 });
    const times = found.map((s) => s.modifiedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('reports a session id that looks like one, and a directory that exists', async () => {
    for (const session of await listResumable({ limit: 4 })) {
      expect(session.sessionId).toMatch(/^[0-9a-f-]{8,}$/i);
      expect(session.cwd.startsWith('/')).toBe(true);
    }
  });

  it('never returns a label containing a newline', async () => {
    // These go into a chip. A multi-line label would break the layout.
    for (const session of await listResumable({ limit: 6 })) {
      if (session.summary !== undefined) expect(session.summary).not.toMatch(/[\r\n]/);
    }
  });
});

describe('which store files are actually resumable', () => {
  it('offers a conversation and skips a summary sidecar beside it', async () => {
    // Not every `.jsonl` next to a conversation is one. A sidecar carries only `summary`
    // records and no `sessionId`, and the agent CLI refuses it with "No conversation found",
    // which read as resume being broken rather than as that row not being a session.
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'),
      `${JSON.stringify({ type: 'user', sessionId: 'aaaaaaaa-0000-0000-0000-000000000001' })}\n`,
    );
    await writeFile(
      join(dir, 'bbbbbbbb-0000-0000-0000-000000000002.jsonl'),
      `${JSON.stringify({ type: 'summary', summary: 'a sidecar, not a session' })}\n`,
    );

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 10 });
    expect(rows.map((r) => r.sessionId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('uses the id the file records rather than its name', async () => {
    // A store that ever renames a file must not make every row resume the wrong thing.
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'named-one-thing.jsonl'),
      `${JSON.stringify({ type: 'user', sessionId: 'recorded-as-another' })}\n`,
    );

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 10 });
    expect(rows[0]?.sessionId).toBe('recorded-as-another');
  });
});
