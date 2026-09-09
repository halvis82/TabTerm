import { describe, expect, it } from 'vitest';
import { answersCurrentQuestion, listWindow, shorten } from './launcher.js';

describe('path display', () => {
  const home = '/Users/someone';

  it('abbreviates the home directory', () => {
    expect(shorten('/Users/someone/Projects/eeg', home)).toBe('~/Projects/eeg');
    expect(shorten('/Users/someone', home)).toBe('~');
  });

  it('leaves paths outside home alone', () => {
    expect(shorten('/usr/local/bin', home)).toBe('/usr/local/bin');
    expect(shorten('/Users/other/thing', home)).toBe('/Users/other/thing');
  });
});

describe('how much of a list to draw', () => {
  // Six collapsed, fifteen open. The two numbers a section needs have to agree with each other:
  // drawing six and then offering nine more is one list counted twice.
  it('draws everything and offers nothing when the list already fits', () => {
    expect(listWindow(4, 6, false)).toEqual({ shown: 4, hidden: 0 });
    expect(listWindow(6, 6, false)).toEqual({ shown: 6, hidden: 0 });
  });

  it('offers exactly the rows that opening out would add', () => {
    expect(listWindow(9, 6, false)).toEqual({ shown: 6, hidden: 3 });
    expect(listWindow(40, 6, false)).toEqual({ shown: 6, hidden: 9 });
  });

  it('keeps offering the control once open, so the section can close again', () => {
    // The count is what the control is worth, not what is currently missing. Deriving it from
    // what is missing makes it zero as soon as the section opens, and the control disappears
    // with no way back.
    expect(listWindow(9, 6, true)).toEqual({ shown: 9, hidden: 3 });
    expect(listWindow(40, 6, true)).toEqual({ shown: 15, hidden: 9 });
  });

  it('never draws past the ceiling, however much the daemon sent', () => {
    expect(listWindow(400, 6, true).shown).toBe(15);
  });
});

describe('which folder answer to believe', () => {
  /**
   * The path was the only thing matched on, and two questions can share a path: typed, replaced,
   * and typed again. Both answers match, and the older arriving last is the one that sticks.
   */
  it('takes the answer to the question being asked', () => {
    expect(answersCurrentQuestion('c7', 'c7')).toBe(true);
  });

  it('drops an answer to a question that has been replaced, same path or not', () => {
    expect(answersCurrentQuestion('c6', 'c7')).toBe(false);
  });

  it('still takes an answer from a daemon that does not echo the id', () => {
    // The field is additive. An older daemon that ignores it must not leave the line under the box
    // blank for good, which is worse than the race it is there to prevent.
    expect(answersCurrentQuestion(undefined, 'c7')).toBe(true);
  });
});
