import { describe, expect, it } from 'vitest';
import { rowText, type PaletteRow, matchesAction } from './palette.js';

const historyRow: PaletteRow = {
  kind: 'history',
  entry: { id: '1', command: 'git status', cwd: '/tmp', lastUsedAt: 0, useCount: 1 },
};
const savedRow: PaletteRow = {
  kind: 'saved',
  item: {
    id: '2',
    kind: 'command',
    pinned: false,
    title: 'Restart backend',
    body: 'npm run backend:restart',
    tags: [],
    createdAt: 0,
    lastUsedAt: 0,
    useCount: 0,
  },
};

describe('palette rows', () => {
  it('takes the command from a history row', () => {
    expect(rowText(historyRow)).toBe('git status');
  });

  it('takes the body, not the title, from a saved row', () => {
    // The title is a label. Pasting it instead of the command would be silently wrong.
    expect(rowText(savedRow)).toBe('npm run backend:restart');
  });
});

describe('action rows', () => {
  it('matches an action by subsequence, the way history search does', () => {
    // `sp` should find "Split right". A palette that only does prefix matching is a menu with
    // extra steps.
    expect(matchesAction('Split right', 'sp')).toBe(true);
    expect(matchesAction('Split right', 'splr')).toBe(true);
    expect(matchesAction('Split right', 'zz')).toBe(false);
  });

  it('ignores spaces in the query, so "cl pane" still finds "Close this pane"', () => {
    expect(matchesAction('Close this pane', 'cl pane')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matchesAction('anything at all', '')).toBe(true);
  });

  it('is case insensitive in both directions', () => {
    expect(matchesAction('Split Right', 'SPLIT')).toBe(true);
    expect(matchesAction('SPLIT RIGHT', 'split')).toBe(true);
  });

  it('respects order, so a reversed query does not match', () => {
    expect(matchesAction('Split right', 'ts')).toBe(false);
  });

  it('reports an action row as its title', () => {
    const row: PaletteRow = {
      kind: 'action',
      action: { id: 'x', title: 'Split right', run: () => {} },
    };
    expect(rowText(row)).toBe('Split right');
  });
});
