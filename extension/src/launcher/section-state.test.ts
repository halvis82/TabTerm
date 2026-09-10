import { describe, expect, it } from 'vitest';
import { parseFolded, portGroupKey } from './section-state.js';

/**
 * What comes back out of storage, which is whatever was there.
 *
 * Extension storage is shared with everything else this extension keeps and survives upgrades, so
 * what is read is not necessarily what this version wrote. A fold is a view preference and the
 * safe answer to anything unrecognised is to show the section.
 */
describe('reading which sections are folded', () => {
  it('keeps the names it knows', () => {
    expect([...parseFolded(['otherPorts'])]).toEqual(['otherPorts']);
  });

  it('ignores a name from another version rather than trusting it', () => {
    expect([...parseFolded(['otherPorts', 'somethingElse'])]).toEqual(['otherPorts']);
  });

  it('keeps every section that can fold', () => {
    const all = ['otherPorts', 'recentFolders', 'resumeAgent', 'reopenRestart'];
    expect([...parseFolded(all)].sort()).toEqual([...all].sort());
  });

  it('keeps a group named after a program, whatever the program is called', () => {
    // The names come from the machine. One this list has never heard of still has to fold.
    expect([...parseFolded([portGroupKey('Google Chrome')])]).toEqual(['port:Google Chrome']);
    expect([...parseFolded([portGroupKey('some-tool-2.0')])]).toEqual(['port:some-tool-2.0']);
  });

  it('refuses a group key with no program in it', () => {
    expect(parseFolded(['port:']).size).toBe(0);
  });

  it('answers nothing folded for anything that is not a list', () => {
    expect(parseFolded(undefined).size).toBe(0);
    expect(parseFolded('otherPorts').size).toBe(0);
    expect(parseFolded({ otherPorts: true }).size).toBe(0);
    expect(parseFolded(null).size).toBe(0);
  });
});
