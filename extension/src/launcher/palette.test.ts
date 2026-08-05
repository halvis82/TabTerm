import { describe, expect, it } from 'vitest';
import { rowText, type PaletteRow } from './palette.js';

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
