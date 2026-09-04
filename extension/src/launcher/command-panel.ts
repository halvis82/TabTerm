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
  /**
   * Which group it belongs to. They answer different questions, so they are drawn apart.
   *
   * `builtin` is what TabTerm can do, `custom` is what somebody taught it, and `manage` is how
   * they teach it something. A flat list put `Make an action` between two things that do
   * something, looking exactly like them, and buried what you had written among what ships.
   */
  group?: 'builtin' | 'custom' | 'manage';
  /** Set when the action is one somebody made, which is what the pencil and cross act on. */
  customId?: string;
  /** The keys bound to it, ready to read. Empty when nothing is bound. */
  keys?: string;
  /** `link` goes somewhere rather than doing something here, so it is not drawn like an action. */
  kind?: 'link' | 'action';
  run: () => void;
}

export type PanelRow =
  | { kind: 'favorite'; item: SavedItem }
  | { kind: 'recent'; entry: CommandEntry }
  | { kind: 'action'; action: PanelAction }
  | { kind: 'heading'; text: string };

/** What a row's text is, for pasting, copying and searching. */
export function rowText(row: PanelRow): string {
  if (row.kind === 'favorite') return row.item.body;
  if (row.kind === 'recent') return row.entry.command;
  if (row.kind === 'heading') return row.text;
  return row.action.title;
}

/** What a row is called, which is not always what it does. */
export function rowLabel(row: PanelRow): string {
  if (row.kind === 'favorite') return row.item.title || row.item.body;
  if (row.kind === 'recent') return row.entry.command;
  if (row.kind === 'heading') return row.text;
  return row.action.title;
}

/**
 * The rows an Actions tab shows for a set of actions, headings included.
 *
 * Here rather than in the view because it is a decision about what the list means, and because
 * a decision with three cases is worth being able to check without a browser.
 */
export function actionRows(
  actions: readonly PanelAction[],
  query: string,
  matcher: (haystack: string, query: string) => boolean = matches,
): PanelRow[] {
  const groups: [group: NonNullable<PanelAction['group']>, heading: string][] = [
    ['builtin', 'What TabTerm can do'],
    ['custom', 'Actions you made'],
    ['manage', 'Make and change them'],
  ];
  const hit = actions.filter((a) => matcher(a.title, query));
  const rows: PanelRow[] = [];
  for (const [group, heading] of groups) {
    const inGroup = hit.filter((a) => (a.group ?? 'builtin') === group);
    if (inGroup.length === 0) continue;
    rows.push({ kind: 'heading', text: heading });
    for (const action of inGroup) rows.push({ kind: 'action', action });
  }
  return rows;
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
  /**
   * A negative coordinate means "never placed", and that lands in the middle.
   *
   * It used to anchor to the top right, beside the button that opens it. That is where the
   * button is, not where a panel wants to be: it covered the corner of the terminal you are
   * most likely to be reading, and a first-run default in a corner reads as a mistake rather
   * than a choice. The middle is where a thing you just opened belongs.
   */
  const x = placement.x < 0 ? Math.round(maxX / 2) : Math.min(maxX, Math.max(0, placement.x));
  const y = placement.y < 0 ? Math.round(maxY / 2) : Math.min(maxY, Math.max(0, placement.y));
  return { ...placement, x: Math.max(0, x), y };
}
