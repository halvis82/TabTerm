import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeDropName,
  dropPath,
  writeDrop,
  sweepDrops,
  isImage,
  needsPngConversion,
  DROP_TTL_MS,
  droppedFileSearchPath,
  droppedLookupName,
  findDroppedFile,
} from './dropped-files.js';

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

describe('deciding an image goes to the clipboard', () => {
  it('believes the type the browser reports', () => {
    expect(isImage('image/png', 'whatever')).toBe(true);
    expect(isImage('image/webp', 'whatever')).toBe(true);
  });

  it('falls back to the name when the browser offers nothing', () => {
    expect(isImage('', 'shot.PNG')).toBe(true);
    expect(isImage('', 'photo.jpeg')).toBe(true);
  });

  it('does not call a text file an image', () => {
    expect(isImage('text/plain', 'notes.txt')).toBe(false);
    expect(isImage('', 'archive.zip')).toBe(false);
  });

  it('converts anything that is not already a PNG, since the clipboard takes PNG data', () => {
    expect(needsPngConversion('image/png', 'a.png')).toBe(false);
    expect(needsPngConversion('', 'a.png')).toBe(false);
    expect(needsPngConversion('image/jpeg', 'a.jpg')).toBe(true);
  });
});

describe('finding a dropped file rather than copying it', () => {
  it('looks in the session, then where files land, then folders this machine knows', () => {
    expect(droppedFileSearchPath('/work/app', '/home/me', ['/work/other'])).toEqual([
      '/work/app',
      '/home/me/Downloads',
      '/home/me/Desktop',
      '/home/me/Documents',
      '/home/me',
      '/work/other',
    ]);
  });

  it('never looks in the same place twice, whatever order it was given', () => {
    const places = droppedFileSearchPath('/home/me/Downloads', '/home/me', ['/home/me', '/x']);
    expect(new Set(places).size).toBe(places.length);
    expect(places[0]).toBe('/home/me/Downloads');
  });

  /**
   * The name as it is, which is the whole difference from `safeDropName`.
   *
   * That one builds a filename safe to write and turns anything it dislikes into a dash, so
   * `a big archive.zip` becomes `a-big-archive.zip` and matches no file that is actually there.
   */
  it('keeps a name that has spaces in it, which is most of them', () => {
    expect(droppedLookupName('a big archive.zip')).toBe('a big archive.zip');
    expect(safeDropName('a big archive.zip')).not.toBe('a big archive.zip');
  });

  it('takes only the last segment, so nothing can climb out of the folder being searched', () => {
    expect(droppedLookupName('../../etc/passwd')).toBe('passwd');
    expect(droppedLookupName('/etc/passwd')).toBe('passwd');
  });

  it('refuses what is not a name', () => {
    expect(droppedLookupName('')).toBe('');
    expect(droppedLookupName('..')).toBe('');
    expect(droppedLookupName('.')).toBe('');
  });
});

/**
 * Finding a file that none of the guesses hold, which is the ordinary case.
 *
 * Reported twice. A 298 MB archive in Downloads, and then a 58 MB file four directories inside
 * it: `~/Downloads/UCSD_local/fall2026/cse258/hw2/beer_50000.json`. Neither was in a place worth
 * guessing at, and both were refused with a message about copying. "it should behave exactly like
 * iterm. files like that should just have their path linked. this should never result in an
 * error."
 */
describe('finding a dropped file anywhere on the machine', () => {
  const here = mkdtempSync(join(tmpdir(), 'tt-find-'));
  const deep = join(here, 'Downloads', 'UCSD_local', 'fall2026', 'cse258', 'hw2');
  mkdirSync(deep, { recursive: true });
  const target = join(deep, 'beer_50000.json');
  writeFileSync(target, 'x'.repeat(4096));

  it('asks the index when the places worth guessing do not have it', async () => {
    const found = await findDroppedFile('beer_50000.json', 4096, [here], () =>
      Promise.resolve([target]),
    );
    expect(found?.path).toBe(target);
    expect(found?.isFile).toBe(true);
  });

  it('prefers the one whose size matches, because a name is not unique', async () => {
    const other = join(here, 'beer_50000.json');
    writeFileSync(other, 'shorter');
    const found = await findDroppedFile('beer_50000.json', 4096, [here], () =>
      Promise.resolve([target]),
    );
    expect(found?.path).toBe(target);
  });

  it('takes a name match when no size matches, rather than refusing the drop', async () => {
    // A file being written to as it is dragged reports a size that is already stale. Answering
    // with the file of that name beats answering with nothing.
    const found = await findDroppedFile('beer_50000.json', 999999, [here], () =>
      Promise.resolve([target]),
    );
    expect(found).not.toBeNull();
  });

  it('says nothing when there is genuinely nothing of that name', async () => {
    expect(
      await findDroppedFile('not-here.json', 10, [here], () => Promise.resolve([])),
    ).toBeNull();
  });

  it('never leaves the places it was given, whatever the name looks like', async () => {
    expect(await findDroppedFile('..', undefined, [here], () => Promise.resolve([]))).toBeNull();
  });
});
