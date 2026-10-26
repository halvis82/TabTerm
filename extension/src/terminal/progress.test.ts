import { describe, expect, it } from 'vitest';
import { parseProgress, tabProgress } from './progress.js';

describe('progress a program reports, OSC 9;4', () => {
  it('reads each state', () => {
    expect(parseProgress('4;1;42')).toEqual({ kind: 'normal', percent: 42 });
    expect(parseProgress('4;2;80')).toEqual({ kind: 'error', percent: 80 });
    expect(parseProgress('4;3')).toEqual({ kind: 'busy', percent: 0 });
    expect(parseProgress('4;4;10')).toEqual({ kind: 'paused', percent: 10 });
    expect(parseProgress('4;0')).toBeNull();
    expect(parseProgress('4')).toBeNull();
  });

  it('keeps the percentage between 0 and 100', () => {
    expect(parseProgress('4;1;250')).toEqual({ kind: 'normal', percent: 100 });
    expect(parseProgress('4;1;')).toEqual({ kind: 'normal', percent: 0 });
  });

  it('leaves every other OSC 9 alone, such as a notification', () => {
    expect(parseProgress('build finished')).toBeUndefined();
    expect(parseProgress('4;9;1')).toBeUndefined();
    expect(parseProgress('42')).toBeUndefined();
  });

  it('shows an error first in a tab of several, then the one least far along', () => {
    expect(
      tabProgress([
        { kind: 'normal', percent: 70 },
        { kind: 'normal', percent: 30 },
      ]),
    ).toEqual({ kind: 'normal', percent: 30 });
    expect(
      tabProgress([
        { kind: 'normal', percent: 10 },
        { kind: 'error', percent: 90 },
      ]),
    ).toEqual({ kind: 'error', percent: 90 });
    expect(tabProgress([{ kind: 'busy', percent: 0 }])).toBeNull();
    expect(tabProgress([])).toBeNull();
  });
});
