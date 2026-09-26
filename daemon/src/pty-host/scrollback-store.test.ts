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
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
    // Compaction happens at a multiple of the budget, so the file is bounded by that.
    expect(statSync(join(dir, 's1.log')).size).toBeLessThan(100 * 3);
  });

  it('writes owner-only, because this is everything a terminal printed', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('s1', bytes('secret'));
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
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
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
    expect(store.usage().files).toBe(1);
    expect(store.read('../../escape')).not.toHaveLength(0);
  });

  it('prunes history nobody has touched in a month', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('old', bytes('ancient'));
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
    store.append('new', bytes('current'));
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
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

  it('makes the file with the right mode again after it is cleared', () => {
    /**
     * The check that the file exists moved to once per session rather than once per chunk, which
     * is where it was costing a syscall on every piece of output. Clearing deletes the file, so
     * the next write has to make it again: a remembered "already made" would leave the recreated
     * file with whatever mode the append happened to give it.
     */
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 64 * 1024 });
    store.append('mode-check', new TextEncoder().encode('first\n'));
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
    store.clear('mode-check');
    store.append('mode-check', new TextEncoder().encode('second\n'));
    // On disk is a question about the file, so the batch goes out first.
    store.flush();
    const path = join(dir, 'mode-check.log');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(store.read('mode-check'))).toContain('second');
  });
});

/**
 * A host runs for months, so tidying only at startup is tidying never.
 *
 * Found on a real machine: 1051 files and 83 MB under a host three days old, the oldest three
 * weeks old and nothing coming to remove it. The prune works; it was only ever asked once.
 */
describe('pruning while the host runs', () => {
  it('removes what is past its age, whenever it is asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-prune-'));
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('old-one', Buffer.from('a'.repeat(64)));
    store.append('new-one', Buffer.from('b'.repeat(64)));
    // Aged past the horizon by asking about a later "now" rather than by touching the clock.
    const month = 31 * 24 * 60 * 60 * 1000;
    expect(store.prune(Date.now() + month)).toBe(2);
    expect(store.prune(Date.now() + month), 'and nothing is left to remove').toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves alone anything younger than the horizon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-prune-keep-'));
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 });
    store.append('fresh', Buffer.from('c'.repeat(64)));
    expect(store.prune(Date.now())).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Writing in batches, which nothing outside can tell apart from writing every chunk.
 *
 * A syscall per chunk blocked the process that holds every terminal: sixteen megabytes arriving
 * in four kilobyte chunks cost 429 ms of wall clock against 119 ms of processor, so most of it
 * was this process sitting in `write` while every other terminal's keystrokes waited. Batched,
 * the same output costs 11 ms.
 *
 * The contract that makes it safe is that everything which looks at a file puts the batch out
 * first, so no caller can ever see a file missing its newest bytes.
 */
describe('writing in batches', () => {
  it('hands back everything that was appended, flushed or not', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 * 1024 });
    for (let i = 0; i < 50; i++) store.append('batch', bytes(`line ${String(i)}\n`));
    const back = Buffer.from(store.read('batch')).toString('utf8');
    expect(back).toContain('line 0\n');
    expect(back).toContain('line 49\n');
  });

  it('does not lose what was written before a clear and a rewrite', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 * 1024 });
    store.append('reused', bytes('first'));
    store.clear('reused');
    store.append('reused', bytes('second'));
    expect(Buffer.from(store.read('reused')).toString('utf8')).toBe('second');
  });

  it('counts what is waiting, so usage is never short', () => {
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 1024 * 1024 });
    store.append('counted', bytes('12345'));
    expect(store.usage().bytes).toBeGreaterThanOrEqual(5);
  });

  it('keeps memory flat under a program that never stops printing', () => {
    // Past the size bound, a batch is written rather than held, so nothing accumulates.
    const store = new ScrollbackStore({ directory: dir, budgetBytes: 8 * 1024 * 1024 });
    const chunk = bytes('x'.repeat(4096));
    for (let i = 0; i < 2000; i++) store.append('flat', chunk);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2000; i++) store.append('flat', chunk);
    const grew = process.memoryUsage().heapUsed - before;
    // Eight megabytes appended; anything near that would mean it was all being held.
    expect(grew).toBeLessThan(4 * 1024 * 1024);
  });
});
