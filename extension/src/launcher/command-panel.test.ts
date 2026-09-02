import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT,
  clampPlacement,
  matches,
  operationsFor,
  rowLabel,
  rowText,
  type PanelRow,
} from './command-panel.js';

const favorite: PanelRow = {
  kind: 'favorite',
  item: {
    id: '1',
    kind: 'command',
    title: 'Build the project',
    body: 'npm run build',
    tags: [],
    createdAt: 0,
    lastUsedAt: 0,
    useCount: 0,
    pinned: false,
  },
};
const recent: PanelRow = {
  kind: 'recent',
  entry: { id: '2', command: 'git status', cwd: '/w', lastUsedAt: 0, useCount: 1 },
};
const action: PanelRow = {
  kind: 'action',
  action: { id: 'split', title: 'Split right', run: () => {} },
};

describe('what a row is, versus what it does', () => {
  it('shows a favorite by its display name and pastes its command', () => {
    // The whole point of a display name: `Build the project` is a better row than the command.
    expect(rowLabel(favorite)).toBe('Build the project');
    expect(rowText(favorite)).toBe('npm run build');
  });

  it('falls back to the command when a favorite has no name', () => {
    const unnamed: PanelRow = { kind: 'favorite', item: { ...favorite.item, title: '' } };
    expect(rowLabel(unnamed)).toBe('npm run build');
  });

  it('shows a recent command as itself', () => {
    expect(rowLabel(recent)).toBe('git status');
    expect(rowText(recent)).toBe('git status');
  });
});

describe('the footer describes the selected row', () => {
  it('offers copy for text, because there is something to copy', () => {
    expect(operationsFor(recent).join(' ')).toContain('Cmd+Enter copies');
  });

  it('does not offer copy for an action', () => {
    // An action is a thing to do, not text. Offering a key that does nothing is worse than
    // leaving it out.
    expect(operationsFor(action).join(' ')).not.toContain('copies');
    expect(operationsFor(action).join(' ')).toContain('Enter runs');
  });

  it('offers editing only on a favorite', () => {
    expect(operationsFor(favorite).join(' ')).toContain('E edits');
    expect(operationsFor(recent).join(' ')).not.toContain('E edits');
  });

  it('offers keeping only on a recent command', () => {
    expect(operationsFor(recent).join(' ')).toContain('Cmd+S keeps');
  });

  it('says something useful with nothing selected', () => {
    expect(operationsFor(undefined)).toEqual(['Arrows to select']);
  });

  it('always mentions double-click, since that is the mouse route', () => {
    for (const row of [favorite, recent, action]) {
      expect(operationsFor(row).join(' ')).toContain('Double-click');
    }
  });
});

describe('searching', () => {
  it('matches a subsequence', () => {
    expect(matches('Split right', 'sp')).toBe(true);
    expect(matches('git checkout', 'gco')).toBe(true);
    expect(matches('Split right', 'zz')).toBe(false);
  });

  it('ignores spaces in the query', () => {
    expect(matches('Close this pane', 'cl pane')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matches('anything', '')).toBe(true);
  });

  it('respects order', () => {
    expect(matches('Split right', 'ts')).toBe(false);
  });
});

describe('remembering where the panel was', () => {
  const viewport = { width: 1200, height: 800 };
  const panel = { width: 420, height: 460 };

  it('starts in the middle, not in a corner', () => {
    /**
     * It used to anchor to the top right, beside the button that opens it. That is where the
     * button is, not where a panel wants to be: it covered the corner of the terminal you are
     * most likely to be reading.
     */
    const placed = clampPlacement(DEFAULT_PLACEMENT, viewport, panel);
    expect(placed.x).toBe(Math.round((viewport.width - panel.width) / 2));
    expect(placed.y).toBe(Math.round((viewport.height - panel.height) / 2));
  });

  it('keeps a remembered position', () => {
    const placed = clampPlacement({ ...DEFAULT_PLACEMENT, x: 100, y: 200 }, viewport, panel);
    expect(placed).toMatchObject({ x: 100, y: 200 });
  });

  it('pulls a position back on screen when the window shrank', () => {
    // A window can be resized or a display disconnected between sessions, and a panel that is
    // now off-screen cannot be dragged back.
    const placed = clampPlacement({ ...DEFAULT_PLACEMENT, x: 5000, y: 5000 }, viewport, panel);
    expect(placed.x).toBeLessThanOrEqual(viewport.width - panel.width);
    expect(placed.y).toBeLessThanOrEqual(viewport.height - panel.height);
  });

  it('never goes negative, even in a window smaller than the panel', () => {
    const placed = clampPlacement(
      { ...DEFAULT_PLACEMENT, x: -50, y: -50 },
      { width: 200, height: 200 },
      panel,
    );
    expect(placed.x).toBeGreaterThanOrEqual(0);
    expect(placed.y).toBeGreaterThanOrEqual(0);
  });

  it('carries the tab and minimized state through', () => {
    const placed = clampPlacement(
      { x: 10, y: 10, tab: 'recent', minimized: true },
      viewport,
      panel,
    );
    expect(placed.tab).toBe('recent');
    expect(placed.minimized).toBe(true);
  });
});
