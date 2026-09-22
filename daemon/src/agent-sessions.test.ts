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

/**
 * The folder a conversation belongs to, which the store's directory name cannot give back.
 *
 * Asked directly: "does it only get the ones from ~/ or the ones from any folder it was started
 * in?" It was very nearly the first. The store flattens `/`, `_` and `.` to the same hyphen and
 * only the first can be put back, so every project with an underscore or a dot in its path decoded
 * to nothing that exists and every conversation in it was invisible. Measured on his machine
 * before the fix: 50 conversations across 4 folders, with 9 of this project's own unreachable.
 * After: 66 across 13.
 */
describe('a conversation in a folder the directory name cannot spell', () => {
  /** A store directory named the way the agent CLI names one, for a path it cannot round-trip. */
  const storeDirFor = (path: string): string =>
    path.replaceAll('/', '-').replaceAll('_', '-').replaceAll('.', '-');

  it('is found, at the folder the session itself records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const root = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    // An underscore, which is the case he has: `~/Documents/personal_coding/TabTerm`.
    const project = join(root, 'personal_coding');
    await mkdir(project, { recursive: true });
    const dir = join(home, storeDirFor(project));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'cccccccc-0000-0000-0000-000000000003.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'cccccccc-0000-0000-0000-000000000003',
        cwd: project,
      })}\n`,
    );

    // No `knownDirs`: nothing has told the daemon about this folder, which is the whole case.
    const rows = await listResumable({ store: home, limit: 10 });
    expect(rows.map((r) => r.cwd)).toEqual([project]);
  });

  it('and is left out when that folder has since gone', async () => {
    // Resuming into a folder that is not there fails immediately, and a row that errors when
    // pressed is worse than no row at all.
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const gone = join(tmpdir(), 'tt-gone_project-never-made');
    const dir = join(home, storeDirFor(gone));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'dddddddd-0000-0000-0000-000000000004.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'dddddddd-0000-0000-0000-000000000004',
        cwd: gone,
      })}\n`,
    );

    expect(await listResumable({ store: home, limit: 10 })).toEqual([]);
  });

  it('and a file that says nothing about where it was is left out too', async () => {
    // Nothing is guessed. Without a folder there is nowhere to resume into.
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const dir = join(home, '-nothing-here-can-be-decoded_at-all');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'eeeeeeee-0000-0000-0000-000000000005.jsonl'),
      `${JSON.stringify({ type: 'user', sessionId: 'eeeeeeee-0000-0000-0000-000000000005' })}\n`,
    );

    expect(await listResumable({ store: home, limit: 10 })).toEqual([]);
  });

  it('and asking for one folder still answers about that folder only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const root = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const wanted = join(root, 'wanted_one');
    const other = join(root, 'other_one');
    await mkdir(wanted, { recursive: true });
    await mkdir(other, { recursive: true });
    for (const [path, id] of [
      [wanted, 'ffffffff-0000-0000-0000-000000000006'],
      [other, 'ffffffff-0000-0000-0000-000000000007'],
    ] as const) {
      const dir = join(home, storeDirFor(path));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${id}.jsonl`),
        `${JSON.stringify({ type: 'user', sessionId: id, cwd: path })}\n`,
      );
    }

    const rows = await listResumable({ store: home, cwd: wanted, limit: 10 });
    expect(rows.map((r) => r.cwd)).toEqual([wanted]);
  });
});

describe('sessions a program wrote, rather than a person', () => {
  /**
   * Claude Code records how it was started, and sessions driven through its SDK land in the same
   * store as sessions somebody typed. On a real machine 123 of 161 stored sessions belonged to one
   * plugin, all of them newer than any real work, so they took every row in the launcher.
   */
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

  it('does not offer a session the agent started for itself', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, 'typed.jsonl'),
      line({ type: 'user', sessionId: 'typed', entrypoint: 'cli' }),
    );
    await writeFile(
      join(dir, 'generated.jsonl'),
      line({ type: 'user', sessionId: 'generated', entrypoint: 'sdk-ts' }),
    );

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 10 });
    expect(rows.map((r) => r.sessionId)).toEqual(['typed']);
  });

  it('still offers one too old to say how it started', async () => {
    // Sessions written by earlier versions carry no entrypoint at all. Hiding real work because a
    // field is missing is the worse mistake of the two, so anything unrecognised is kept.
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'old.jsonl'), line({ type: 'user', sessionId: 'old' }));

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 10 });
    expect(rows.map((r) => r.sessionId)).toEqual(['old']);
  });

  it('fills the list with real sessions even when the generated ones are newer', async () => {
    /**
     * The property that matters, and the one a filter applied after the slice would fail.
     *
     * Generated sessions are written continuously, so they are always the newest. Taking the first
     * `limit` and then dropping them returns a nearly empty list while real sessions sit just
     * below the cut.
     */
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });

    for (let i = 0; i < 6; i++) {
      await writeFile(
        join(dir, `real-${i}.jsonl`),
        line({ type: 'user', sessionId: `real-${i}`, entrypoint: 'cli' }),
      );
    }
    // Written afterwards, so every one of them is newer than every real session.
    for (let i = 0; i < 20; i++) {
      await writeFile(
        join(dir, `bot-${i}.jsonl`),
        line({ type: 'user', sessionId: `bot-${i}`, entrypoint: 'sdk-ts' }),
      );
    }

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 5 });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.sessionId.startsWith('real-'))).toBe(true);
  });

  it('rejects one whose entrypoint is buried inside an enormous first record', async () => {
    /**
     * The shape that defeated the first attempt at this, which read the start of the file.
     *
     * The field sits inside the first conversation record, and in these sessions that record runs
     * to a median of 159 KB. A bounded head read returns a truncated line, the line does not
     * parse, no entrypoint is found, and every session it was meant to reject is kept. Read from
     * the end instead, where the field repeats on every turn.
     */
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });

    const enormous = {
      type: 'user',
      sessionId: 'buried',
      entrypoint: 'sdk-ts',
      message: { content: 'x'.repeat(400_000) },
    };
    // The id is readable from the start, so the only thing that can keep this row out of the list
    // is seeing the entrypoint. A file that cannot even be identified is refused for another
    // reason entirely, and would pass this test while proving nothing.
    await writeFile(
      join(dir, 'buried.jsonl'),
      line({ type: 'user', sessionId: 'buried' }) +
        line(enormous) +
        line({ type: 'assistant', sessionId: 'buried', entrypoint: 'sdk-ts' }),
    );

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 10 });
    expect(rows).toEqual([]);
  });

  it('labels a session with the title the agent kept, not the first thing typed', async () => {
    // The title is rewritten as the work moves on, so the last one is the one that describes the
    // session. The first prompt is often a pasted path, or a question whose subject only became
    // clear later.
    const home = await mkdtemp(join(tmpdir(), 'tt-store-'));
    const project = await mkdtemp(join(tmpdir(), 'tt-proj-'));
    const dir = join(home, project.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, 'titled.jsonl'),
      line({
        type: 'user',
        sessionId: 'titled',
        entrypoint: 'cli',
        message: { content: '/Users/x/notes.md talk to me' },
      }) +
        line({ type: 'ai-title', aiTitle: 'an early guess' }) +
        line({ type: 'ai-title', aiTitle: 'Rework the payment retry' }),
    );

    const rows = await listResumable({ store: home, knownDirs: [project], limit: 10 });
    expect(rows[0]?.summary).toBe('Rework the payment retry');
  });
});
