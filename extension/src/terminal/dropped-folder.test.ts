import { describe, expect, it } from 'vitest';
import { resolveDroppedFolder } from './dropped-folder.js';

/**
 * A folder dropped on a pane, which Chrome describes by name and nothing else.
 *
 * Reported as "drag and drop folders doesn't work… it should just give hte path to the folder".
 * The path is exactly what a browser will not hand over: a dropped file arrives as bytes with no
 * location, and a folder has no bytes either, so it went down the path that reads a file and
 * reported that it could not be read.
 *
 * The name is real, and the folders this machine is known to work in are already on the start
 * screen. A name matching exactly one of them is an answer. Two matches is not, and picking one
 * would put somebody in the wrong directory, which is worse than saying so.
 */
describe('a folder dropped on a pane', () => {
  const known = [
    '/Users/somebody/Documents/personal_coding/TabTerm',
    '/Users/somebody/Downloads/puzzle_pre_processor',
    '/Users/somebody/Documents/work/api',
  ];

  it('resolves to the one folder of that name', () => {
    expect(resolveDroppedFolder('puzzle_pre_processor', known)).toEqual({
      path: '/Users/somebody/Downloads/puzzle_pre_processor',
    });
  });

  it('says nothing useful when the name is not one this machine knows', () => {
    expect(resolveDroppedFolder('somewhere-else', known)).toEqual({ ambiguous: 0 });
  });

  /*
   * Two folders with the same name is the ordinary case for anybody with more than one project,
   * and the drop carries nothing that tells them apart.
   */
  it('and refuses to guess between two of the same name', () => {
    const twice = [...known, '/Users/somebody/archive/api'];
    expect(resolveDroppedFolder('api', twice)).toEqual({ ambiguous: 2 });
  });

  it('matches the last segment rather than anywhere in the path', () => {
    // "Downloads" appears inside a known path but is not itself one of them.
    expect(resolveDroppedFolder('Downloads', known)).toEqual({ ambiguous: 0 });
  });

  it('and one folder listed twice is still one folder', () => {
    expect(resolveDroppedFolder('api', [...known, '/Users/somebody/Documents/work/api'])).toEqual({
      path: '/Users/somebody/Documents/work/api',
    });
  });
});
