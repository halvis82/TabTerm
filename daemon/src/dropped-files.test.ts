import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeDropName, dropPath, writeDrop, sweepDrops, DROP_TTL_MS } from './dropped-files.js';

describe('the name a dropped file is written under', () => {
  it('keeps an ordinary name as it is', () => {
    expect(safeDropName('screenshot.png')).toBe('screenshot.png');
  });

  it('takes only the last segment, whichever separator built the rest', () => {
    expect(safeDropName('../../etc/passwd')).toBe('passwd');
    expect(safeDropName('C:\\Windows\\notes.txt')).toBe('notes.txt');
  });

  it('rebuilds anything else out of characters it allows', () => {
    expect(safeDropName('my photo (1).png')).toBe('my-photo-1-.png');
    expect(safeDropName('a\u0000b.txt')).toBe('a-b.txt');
  });

  it('never produces a hidden file or an empty name', () => {
    expect(safeDropName('.ssh')).toBe('ssh');
    expect(safeDropName('...')).toBe('dropped-file');
    expect(safeDropName('')).toBe('dropped-file');
  });

  it('does not let a name grow without bound', () => {
    expect(safeDropName('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe('where a dropped file lands', () => {
  it('stays inside the directory it was given', () => {
    const path = dropPath('/state/dropped', '../../../etc/passwd', 0, 'aaaa');
    expect(path.startsWith('/state/dropped/')).toBe(true);
    expect(path).not.toContain('..');
  });

  it('does not collide when the same name is dropped twice', () => {
    const a = dropPath('/d', 'a.png', 1000, 'aaaa');
    const b = dropPath('/d', 'a.png', 1000, 'bbbb');
    expect(a).not.toBe(b);
  });
});

describe('sweeping up old copies', () => {
  it('removes what is past its age and keeps what is not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-drops-'));
    const old = join(dir, 'old.png');
    const fresh = join(dir, 'fresh.png');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const now = Date.now();
    const longAgo = (now - DROP_TTL_MS - 1000) / 1000;
    utimesSync(old, longAgo, longAgo);

    expect(await sweepDrops(dir, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('says nothing was removed when there is no directory at all', async () => {
    expect(await sweepDrops(join(tmpdir(), 'tt-drops-not-here'), Date.now())).toBe(0);
  });
});

describe('writing a drop', () => {
  it('writes the bytes where it says it did', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tt-drops-')), 'dropped');
    const path = await writeDrop(dir, 'note.txt', new TextEncoder().encode('hello'), 0, 'aaaa');
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
