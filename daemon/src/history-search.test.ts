import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** Rows are inserted directly, so a test can set an age and a repository without a clock. */
function seeded(
  rows: {
    command: string;
    cwd: string;
    at: number;
    exit?: number;
    ms?: number;
    root?: string;
    session?: string;
  }[],
): LauncherData {
  const db = new Database(':memory:');
  const stmt = db.handle.prepare(
    `INSERT INTO commands (id, command, cwd, last_used_at, use_count, exit_code, duration_ms, git_root, session_id)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      randomUUID(),
      r.command,
      r.cwd,
      r.at,
      r.exit ?? null,
      r.ms ?? null,
      r.root ?? null,
      r.session ?? null,
    );
  }
  return new LauncherData(db);
}

const sample = () =>
  seeded([
    {
      command: 'npm test',
      cwd: '/w/app/src',
      at: NOW - DAY,
      exit: 0,
      ms: 4000,
      root: '/w/app',
      session: 's1',
    },
    {
      command: 'npm run build',
      cwd: '/w/app',
      at: NOW - 2 * DAY,
      exit: 1,
      ms: 12_000,
      root: '/w/app',
    },
    {
      command: 'git commit',
      cwd: '/w/other',
      at: NOW - 30 * DAY,
      exit: 0,
      ms: 80,
      root: '/w/other',
    },
    { command: 'ls', cwd: '/tmp', at: NOW - 3 * DAY, exit: 0, ms: 5 },
  ]);

const found = (data: LauncherData, query: string, extra = {}) =>
  data.search({ query, now: NOW, ...extra }).map((e) => e.command);

describe('history search', () => {
  it('finds by plain text', () => {
    expect(found(sample(), 'npm').sort()).toEqual(['npm run build', 'npm test']);
  });

  it('still matches a subsequence, so gco finds git commit', () => {
    // The whole reason the fuzzy pass exists. A LIKE alone would miss this.
    expect(found(sample(), 'gcom')).toContain('git commit');
  });

  it('filters by project', () => {
    expect(found(sample(), 'project:app').sort()).toEqual(['npm run build', 'npm test']);
  });

  it('filters by directory, including everything under it', () => {
    expect(found(sample(), 'cwd:/w/app').sort()).toEqual(['npm run build', 'npm test']);
  });

  it('filters by exit status', () => {
    expect(found(sample(), 'exit:fail')).toEqual(['npm run build']);
    expect(found(sample(), 'exit:ok').length).toBe(3);
  });

  it('filters by duration', () => {
    expect(found(sample(), 'duration:>5s')).toEqual(['npm run build']);
    expect(found(sample(), 'duration:<1s').sort()).toEqual(['git commit', 'ls']);
  });

  it('filters by time range', () => {
    expect(found(sample(), 'since:4d').sort()).toEqual(['ls', 'npm run build', 'npm test']);
    expect(found(sample(), 'before:10d')).toEqual(['git commit']);
  });

  it('combines filters with text', () => {
    expect(found(sample(), 'project:app exit:fail build')).toEqual(['npm run build']);
  });

  it('scopes to a session without the user typing anything', () => {
    expect(found(sample(), '', { scope: 'session', context: { sessionId: 's1' } })).toEqual([
      'npm test',
    ]);
  });

  it('shows everything when a scope has no context to apply', () => {
    // Outside a repository, "this project" must not silently show an empty history.
    expect(found(sample(), '', { scope: 'project', context: {} }).length).toBe(4);
  });

  it('pages rather than returning everything', () => {
    const data = seeded(
      Array.from({ length: 250 }, (_, i) => ({
        command: `cmd-${String(i).padStart(3, '0')}`,
        cwd: '/w',
        at: NOW - i * 1000,
      })),
    );
    const first = data.search({ limit: 100, now: NOW });
    const second = data.search({ limit: 100, offset: 100, now: NOW });
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(new Set([...first, ...second].map((e) => e.id)).size).toBe(200);

    const last = data.search({ limit: 100, offset: 200, now: NOW });
    expect(last).toHaveLength(50); // a short page is the last page
  });

  it('caps an absurd page size instead of honoring it', () => {
    const data = seeded(
      Array.from({ length: 400 }, (_, i) => ({ command: `c${String(i)}`, cwd: '/w', at: NOW - i })),
    );
    expect(data.search({ limit: 100_000, now: NOW }).length).toBeLessThanOrEqual(200);
  });

  it('records the session a command ran in, so the session scope works at all', () => {
    // The column existed before anything wrote to it, and "this session" silently returned
    // nothing. A schema change is not done until something fills it in.
    const data = new LauncherData(new Database(':memory:'));
    data.recordCommand({ command: 'echo hi', cwd: '/w', sessionId: 'sess-1' });
    expect(
      data
        .search({ scope: 'session', context: { sessionId: 'sess-1' }, now: NOW })
        .map((e) => e.command),
    ).toEqual(['echo hi']);
    expect(data.search({ scope: 'session', context: { sessionId: 'other' }, now: NOW })).toEqual(
      [],
    );
  });

  it('moves a repeated command to the session that just ran it', () => {
    const data = new LauncherData(new Database(':memory:'));
    data.recordCommand({ command: 'ls', cwd: '/w', sessionId: 'a' });
    data.recordCommand({ command: 'ls', cwd: '/w', sessionId: 'b' });
    expect(data.search({ scope: 'session', context: { sessionId: 'b' }, now: NOW })).toHaveLength(
      1,
    );
  });

  it('carries the repository through to the result', () => {
    expect(sample().search({ query: 'npm test', now: NOW })[0]?.gitRoot).toBe('/w/app');
  });

  it('stays within budget on 100k rows', () => {
    // The number that decides whether the query language is usable at all.
    const db = new Database(':memory:');
    const stmt = db.handle.prepare(
      `INSERT INTO commands (id, command, cwd, last_used_at, use_count, exit_code, duration_ms, git_root)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    db.handle.exec('BEGIN');
    for (let i = 0; i < 100_000; i++) {
      stmt.run(
        randomUUID(),
        `command number ${String(i)} doing something`,
        `/w/p${String(i % 50)}/sub`,
        NOW - i * 1000,
        i % 7 === 0 ? 1 : 0,
        i % 3000,
        `/w/p${String(i % 50)}`,
      );
    }
    db.handle.exec('COMMIT');
    const data = new LauncherData(db);

    const timed = (label: string, run: () => unknown) => {
      run(); // once to warm any statement preparation
      const t0 = performance.now();
      run();
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`    ${label}: ${ms.toFixed(1)} ms`);
      return ms;
    };

    expect(timed('unfiltered page', () => data.search({ limit: 100, now: NOW }))).toBeLessThan(50);
    expect(
      timed('project + exit', () =>
        data.search({ query: 'project:p7 exit:fail', limit: 100, now: NOW }),
      ),
    ).toBeLessThan(50);
    expect(
      timed('text + filters', () =>
        data.search({ query: 'project:p7 exit:fail something', limit: 100, now: NOW }),
      ),
    ).toBeLessThan(150);
    expect(
      timed('deep page', () => data.search({ limit: 100, offset: 5000, now: NOW })),
    ).toBeLessThan(50);
    db.close();
  });
});
