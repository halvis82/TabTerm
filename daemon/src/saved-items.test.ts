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
    // Recording, not display: these paths are deliberately not on this disk, and the display
    // path drops folders that no longer exist.
    data.recordDir('/Users/someone/Projects/app');
    expect(data.recentDirs(12, { requireExists: false }).map((d) => d.path)).toEqual([
      '/Users/someone/Projects/app',
    ]);
  });

  it('does not confuse a real path that merely starts similarly', () => {
    const data = fresh();
    data.recordDir('/var/folders-of-mine/project');
    expect(data.recentDirs(12, { requireExists: false }).map((d) => d.path)).toEqual([
      '/var/folders-of-mine/project',
    ]);
  });
});

describe('hotstrings on favorites', () => {
  it('stores and reports one', () => {
    const data = fresh();
    const item = data.save({ title: 'Build', body: 'npm run build' });
    expect(data.updateSaved(item.id, { hotstring: 'runbuild!' })).toEqual({ ok: true });
    expect(data.saved()[0]?.hotstring).toBe('runbuild!');
    expect(data.hotstrings()).toEqual([{ trigger: 'runbuild!', command: 'npm run build' }]);
  });

  it('refuses a trigger another favorite already claims', () => {
    // Silently moving it would mean an abbreviation someone relies on quietly starts doing
    // something else.
    const data = fresh();
    const a = data.save({ title: 'A', body: 'command a' });
    const b = data.save({ title: 'B', body: 'command b' });
    data.updateSaved(a.id, { hotstring: 'x!' });

    const result = data.updateSaved(b.id, { hotstring: 'x!' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('already uses');
    expect(data.hotstrings()).toHaveLength(1);
  });

  it('lets a favorite keep its own trigger when edited', () => {
    const data = fresh();
    const item = data.save({ title: 'A', body: 'command a' });
    data.updateSaved(item.id, { hotstring: 'x!' });
    expect(data.updateSaved(item.id, { hotstring: 'x!', title: 'Renamed' })).toEqual({ ok: true });
    expect(data.saved()[0]?.title).toBe('Renamed');
  });

  it('refuses a trigger containing a space', () => {
    // A space is what ends an abbreviation, so one containing a space could never be completed.
    const data = fresh();
    const item = data.save({ title: 'A', body: 'a' });
    const result = data.updateSaved(item.id, { hotstring: 'two words' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('spaces');
  });

  it('clears the trigger when given an empty value', () => {
    const data = fresh();
    const item = data.save({ title: 'A', body: 'a' });
    data.updateSaved(item.id, { hotstring: 'x!' });
    data.updateSaved(item.id, { hotstring: '' });
    expect(data.saved()[0]?.hotstring).toBeUndefined();
    expect(data.hotstrings()).toEqual([]);
  });

  it('leaves the trigger alone when the edit does not mention it', () => {
    const data = fresh();
    const item = data.save({ title: 'A', body: 'a' });
    data.updateSaved(item.id, { hotstring: 'x!' });
    data.updateSaved(item.id, { title: 'Renamed only' });
    expect(data.saved()[0]?.hotstring).toBe('x!');
  });

  it('edits the display name and the command independently', () => {
    const data = fresh();
    const item = data.save({ title: 'Old name', body: 'old command' });
    data.updateSaved(item.id, { title: 'New name' });
    expect(data.saved()[0]).toMatchObject({ title: 'New name', body: 'old command' });
    data.updateSaved(item.id, { body: 'new command' });
    expect(data.saved()[0]).toMatchObject({ title: 'New name', body: 'new command' });
  });

  it('reports a missing item rather than pretending', () => {
    expect(fresh().updateSaved('nope', { title: 'x' }).ok).toBe(false);
  });
});

describe('folders that are no longer there', () => {
  it('stops offering a directory once it is gone', () => {
    // Test fixtures created real directories and deleted them, and the rows stayed forever, so
    // the list filled with paths that could not be opened. Offering one is offering nothing.
    const db = new Database(':memory:');
    const data = new LauncherData(db);
    data.recordDir('/Users/someone/deleted-project');
    expect(data.recentDirs(12, { requireExists: false })).toHaveLength(1);
    expect(data.recentDirs()).toHaveLength(0);
  });

  it('keeps a pinned folder even when it cannot be seen right now', () => {
    // Somebody who pinned a path meant it, and a disk that is not mounted today may be tomorrow.
    const db = new Database(':memory:');
    const data = new LauncherData(db);
    data.recordDir('/Volumes/external/work');
    data.pinDir('/Volumes/external/work', true);
    expect(data.recentDirs().map((d) => d.path)).toEqual(['/Volumes/external/work']);
  });
});
