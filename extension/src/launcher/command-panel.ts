import type { CommandEntry, SavedItem } from '@tabterm/shared';

/**
 * The command panel.
 *
 * A floating, persistent surface for the commands you reuse: the ones you kept, the ones you
 * ran, and the things you can do to a pane. See docs/14-command-menu.md.
 *
 * It is a panel and not a dialog, which drives most of what is below. It is translucent because
 * there is terminal output behind it and hiding that is the one thing a terminal panel must not
 * do. It can be dragged, because a fixed position is wrong for something sitting over content
 * you are reading. It remembers where you put it and which tab you were on, because it is
 * furniture rather than a prompt.
 */

export type PanelTab = 'favorites' | 'recent' | 'actions' | 'stats';

export interface PanelAction {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

export type PanelRow =
  | { kind: 'favorite'; item: SavedItem }
  | { kind: 'recent'; entry: CommandEntry }
  | { kind: 'action'; action: PanelAction };

/** What a row's text is, for pasting, copying and searching. */
export function rowText(row: PanelRow): string {
  if (row.kind === 'favorite') return row.item.body;
  if (row.kind === 'recent') return row.entry.command;
  return row.action.title;
}

/** What a row is called, which is not always what it does. */
export function rowLabel(row: PanelRow): string {
  if (row.kind === 'favorite') return row.item.title || row.item.body;
  if (row.kind === 'recent') return row.entry.command;
  return row.action.title;
}

/** Subsequence match, so `sp` finds `Split right` the way `gco` finds `git checkout`. */
export function matches(haystack: string, query: string): boolean {
  if (!query) return true;
  const target = haystack.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    if (ch === ' ') continue;
    at = target.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

/**
 * What the footer says for a given row.
 *
 * Built from the row rather than fixed, because the operations genuinely differ: an action has
 * nothing to copy, and saying so by omission is clearer than offering a key that does nothing.
 */
export function operationsFor(row: PanelRow | undefined): string[] {
  if (!row) return ['Arrows to select'];
  if (row.kind === 'action') return ['Enter runs', 'Double-click runs', 'Esc closes'];
  const common = ['Enter pastes', 'Double-click pastes', 'Cmd+Enter copies'];
  if (row.kind === 'favorite') return [...common, 'E edits'];
  return [...common, 'Cmd+S keeps'];
}

export interface PanelPlacement {
  x: number;
  y: number;
  tab: PanelTab;
  minimized: boolean;
}

export const DEFAULT_PLACEMENT: PanelPlacement = {
  x: -1,
  y: -1,
  tab: 'favorites',
  minimized: false,
};

/**
 * Keep the panel on screen.
 *
 * A window can be resized or a display disconnected between sessions, and a remembered position
 * that is now off-screen leaves no way to get it back short of clearing storage.
 */
export function clampPlacement(
  placement: PanelPlacement,
  viewport: { width: number; height: number },
  panel: { width: number; height: number },
): PanelPlacement {
  const maxX = Math.max(0, viewport.width - panel.width);
  const maxY = Math.max(0, viewport.height - panel.height);
  // -1 means "never placed", which anchors it to the top right where the button is.
  const x = placement.x < 0 ? maxX - 12 : Math.min(maxX, Math.max(0, placement.x));
  const y = placement.y < 0 ? 12 : Math.min(maxY, Math.max(0, placement.y));
  return { ...placement, x: Math.max(0, x), y };
}
