import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrollbackStore } from './scrollback-store.js';

let dir = '';
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (u: Uint8Array) => new TextDecoder().decode(u);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-scrollback-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scrollback on disk', () => {
  it('keeps what a session printed', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('s1', bytes('hello '));
    store.append('s1', bytes('world'));
    expect(text(store.read('s1'))).toBe('hello world');
  });

  it('returns nothing for a session it has never seen', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    expect(store.read('missing')).toHaveLength(0);
  });

  it('keeps the newest output when the budget is passed', () => {
    // The recent past is what anyone wants back, so the front is what goes.
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 64 });
    for (let i = 0; i < 40; i++) store.append('s1', bytes(`line-${String(i)}\n`));
    const kept = text(store.read('s1'));
    expect(kept.length).toBeLessThanOrEqual(64);
    expect(kept).toContain('line-39');
    expect(kept).not.toContain('line-0\n');
  });

  it('keeps the file itself bounded, not only what it hands back', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 100 });
    for (let i = 0; i < 500; i++) store.append('s1', bytes(`0123456789\n`));
    // Compaction happens at a multiple of the budget, so the file is bounded by that.
    expect(statSync(join(dir, 's1.log')).size).toBeLessThan(100 * 3);
  });

  it('writes owner-only, because this is everything a terminal printed', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('s1', bytes('secret'));
    expect(statSync(join(dir, 's1.log')).mode & 0o077).toBe(0);
  });

  it('clears, and the output does not come back', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('s1', bytes('a token'));
    store.clear('s1');
    expect(store.read('s1')).toHaveLength(0);
  });

  it('refuses a session id that is really a path', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('../../escape', bytes('nope'));
    expect(store.usage().files).toBe(1);
    expect(store.read('../../escape')).not.toHaveLength(0);
  });

  it('prunes history nobody has touched in a month', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('old', bytes('ancient'));
    store.append('new', bytes('current'));
    const longAgo = Date.now() / 1000 - 60 * 24 * 60 * 60;
    utimesSync(join(dir, 'old.log'), longAgo, longAgo);
    expect(store.prune()).toBe(1);
    expect(store.read('old')).toHaveLength(0);
    expect(text(store.read('new'))).toBe('current');
  });

  it('reports what it is costing', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('s1', bytes('12345'));
    store.append('s2', bytes('123'));
    expect(store.usage()).toEqual({ files: 2, bytes: 8 });
  });

  it('ignores files it did not write', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    writeFileSync(join(dir, 'notes.txt'), 'not ours');
    expect(store.usage().files).toBe(0);
  });
});
