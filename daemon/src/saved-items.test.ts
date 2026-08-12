import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';

const fresh = () => new LauncherData(new Database(':memory:'));

describe('saved items', () => {
  it('defaults to a command, which is what most saved text is', () => {
    expect(fresh().save({ title: 'restart', body: 'npm run dev' }).kind).toBe('command');
  });

  it('keeps the kinds distinct, because they are used differently', () => {
    const data = fresh();
    for (const kind of ['command', 'template', 'note', 'prompt', 'workflow'] as const) {
      data.save({ kind, title: kind, body: `body for ${kind}` });
    }
    expect(data.saved({ kind: 'note' }).map((i) => i.title)).toEqual(['note']);
    expect(data.saved()).toHaveLength(5);
  });

  it('records tags, usage count, and last used', () => {
    const data = fresh();
    const item = data.save({ title: 'deploy', body: 'make deploy', tags: ['ops', 'release'] });
    expect(item.tags).toEqual(['ops', 'release']);
    expect(item.useCount).toBe(0);

    data.markUsed(item.id);
    data.markUsed(item.id);
    expect(data.saved()[0]?.useCount).toBe(2);
  });

  it('offers project items alongside global ones, never instead of them', () => {
    // Being inside a repository should add to what you are offered. Replacing the global list
    // would hide things people saved deliberately.
    const data = fresh();
    data.save({ title: 'everywhere', body: 'ls' });
    data.save({ title: 'this repo', body: 'make test', gitRoot: '/w/app' });
    data.save({ title: 'other repo', body: 'make other', gitRoot: '/w/other' });

    expect(
      data
        .saved({ gitRoot: '/w/app' })
        .map((i) => i.title)
        .sort(),
    ).toEqual(['everywhere', 'this repo']);
    expect(data.saved().map((i) => i.title)).toHaveLength(3);
  });

  it('reports the placeholders in a body, so the UI does not have to re-parse', () => {
    const data = fresh();
    data.save({ title: 'deploy', body: 'deploy {{env}} --tag {{tag:latest}}' });
    expect(data.saved()[0]?.placeholders).toEqual(['env', 'tag']);
  });

  it('reports no placeholders rather than an empty list for a plain command', () => {
    const data = fresh();
    data.save({ title: 'plain', body: 'npm test' });
    expect(data.saved()[0]?.placeholders).toBeUndefined();
  });

  it('puts pinned items first regardless of when they were last used', () => {
    const data = fresh();
    const old = data.save({ title: 'old', body: 'a' });
    data.save({ title: 'new', body: 'b' });
    data.pinSaved(old.id, true);
    expect(data.saved()[0]?.title).toBe('old');
    expect(data.saved()[0]?.pinned).toBe(true);
  });

  it('deletes on request', () => {
    const data = fresh();
    const item = data.save({ title: 'x', body: 'y' });
    data.deleteSaved(item.id);
    expect(data.saved()).toEqual([]);
  });

  it('caps title, body, and tags rather than storing whatever it is handed', () => {
    const data = fresh();
    const item = data.save({
      title: 'x'.repeat(1000),
      body: 'y'.repeat(10_000),
      tags: Array.from({ length: 50 }, (_, i) => `tag${String(i)}`.repeat(20)),
    });
    expect(item.title.length).toBeLessThanOrEqual(200);
    expect(item.body.length).toBeLessThanOrEqual(4000);
    expect(item.tags.length).toBeLessThanOrEqual(12);
    expect(item.tags.every((t) => t.length <= 40)).toBe(true);
  });

  it('treats an unknown kind in the database as a command', () => {
    // Migration 5 defaults existing rows to 'command'. A row written by a newer version must
    // not break an older one.
    const db = new Database(':memory:');
    db.handle
      .prepare(
        `INSERT INTO saved_items (id, kind, title, body, tags, created_at, last_used_at, use_count, pinned)
         VALUES ('a', 'something-new', 't', 'b', '', 1, 1, 0, 0)`,
      )
      .run();
    expect(new LauncherData(db).saved()[0]?.kind).toBe('command');
  });
});

describe('recent directories', () => {
  it('never offers a temporary directory back', () => {
    // A build, a test run, or an installer works in one, and every one of them is gone by the
    // time anybody would click it. macOS puts per-user temp under /var/folders, which does not
    // look temporary from the path alone.
    const data = fresh();
    for (const dir of [
      '/var/folders/p7/abc/T/tt-project-x',
      '/private/var/folders/p7/abc/T/build',
      '/tmp/scratch',
      '/private/tmp/scratch',
    ]) {
      data.recordDir(dir);
    }
    expect(data.recentDirs()).toEqual([]);
  });

  it('still records real project directories', () => {
    const data = fresh();
    data.recordDir('/Users/someone/Projects/app');
    expect(data.recentDirs().map((d) => d.path)).toEqual(['/Users/someone/Projects/app']);
  });

  it('does not confuse a real path that merely starts similarly', () => {
    const data = fresh();
    data.recordDir('/var/folders-of-mine/project');
    expect(data.recentDirs().map((d) => d.path)).toEqual(['/var/folders-of-mine/project']);
  });
});
