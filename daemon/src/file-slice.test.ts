import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readHead, readTail } from './file-slice.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-slice-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Reading one end of a file without reading the rest of it.
 *
 * The three callers all wanted a small piece of an agent's stored conversation and all got it by
 * reading the whole file into a string first. On a machine with a year of these that is hundreds
 * of megabytes to show a one-line preview, and it is what took the daemon down on an out of
 * memory. The check that matters is the last one: the cost is what is asked for.
 */
describe('reading one end of a file', () => {
  it('gives the first bytes and nothing after them', async () => {
    const path = join(dir, 'head.txt');
    await writeFile(path, 'first line\nsecond line\nthird line\n');
    expect(await readHead(path, 11)).toBe('first line\n');
  });

  it('gives the whole of a file shorter than the piece asked for', async () => {
    const path = join(dir, 'short.txt');
    await writeFile(path, 'all of it');
    expect(await readHead(path, 4096)).toBe('all of it');
    expect(await readTail(path, 4096)).toBe('all of it');
  });

  it('gives the last bytes, dropping the record it landed in the middle of', async () => {
    const path = join(dir, 'tail.txt');
    await writeFile(path, 'one\ntwo\nthree\nfour\n');
    // Twelve bytes back is inside `two`, so that line goes and the whole ones remain.
    expect(await readTail(path, 12)).toBe('three\nfour\n');
  });

  it('is not confused by a character split across the boundary', async () => {
    // A read that starts mid-file starts mid-character as often as not, and a broken one decodes
    // to a replacement mark. Dropping the first line takes it with it.
    const path = join(dir, 'wide.txt');
    await writeFile(path, `${'中'.repeat(40)}\nplain\n`);
    expect(await readTail(path, 20)).toBe('plain\n');
  });

  it('costs what it returns, rather than the size of the file', async () => {
    /**
     * The whole reason this exists.
     *
     * A JavaScript string holds text as sixteen-bit units, so reading a hundred megabyte file to
     * look at its first hundred kilobytes costs two hundred megabytes. Measured rather than
     * asserted: the heap before and after, on a file far larger than the piece being read.
     */
    const path = join(dir, 'big.txt');
    await writeFile(path, `${'x'.repeat(40 * 1024 * 1024)}\n`);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const head = await readHead(path, 64 * 1024);
    const after = process.memoryUsage().heapUsed;
    expect(head.length).toBe(64 * 1024);
    // Room for the string itself and ordinary noise, nowhere near the forty megabyte file.
    expect(after - before).toBeLessThan(4 * 1024 * 1024);
  });
});
