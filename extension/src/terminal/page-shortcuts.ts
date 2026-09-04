/**
 * Shortcuts the page handles itself, and which of them you are allowed to choose.
 *
 * Chrome lets a person rebind only what an extension declares as a command, and a command fires
 * in the service worker rather than in a page. Everything that acts on a pane is therefore
 * handled here, in the page, which means Chrome's own settings screen can never show it. So the
 * choosing happens here instead.
 *
 * The hard part is not the storing. It is that **a key Chrome has claimed never arrives**: the
 * page is not asked, and nothing fires. Somebody who binds Command W to "close this pane" would
 * watch their tab close and reasonably conclude the product is broken. So a binding is refused
 * before it is saved, with the reason.
 */

export interface PageShortcut {
  id: string;
  /** What it does, in the words the command menu uses for it. */
  title: string;
  /** As typed, such as `Shift+Meta+D`. Empty means nothing is bound. */
  keys: string;
}

/**
 * What ships, and why these keys.
 *
 * Command and Shift together, because Command alone belongs to Chrome and to the shell, and
 * because a shell needs every bare Control sequence there is. Split down was on Command Shift E
 * while the command menu claimed Command Shift D was split down, which is why one of them
 * appeared to do the wrong thing: it was doing exactly what it was bound to.
 */
export const DEFAULT_PAGE_SHORTCUTS: PageShortcut[] = [
  { id: 'command-menu', title: 'Open the command menu', keys: 'Meta+K' },
  { id: 'split-right', title: 'Split right', keys: 'Shift+Meta+D' },
  { id: 'split-down', title: 'Split down', keys: 'Shift+Meta+E' },
  { id: 'close-pane', title: 'Close this pane', keys: 'Shift+Meta+W' },
  { id: 'detach-pane', title: 'Move this pane to its own tab', keys: 'Shift+Meta+X' },
  { id: 'launch-agent', title: 'Launch an agent', keys: 'Shift+Meta+A' },
  { id: 'clear-screen', title: 'Clear the screen', keys: 'Shift+Meta+K' },
  { id: 'palette', title: 'Open the command palette', keys: 'Shift+Meta+P' },
];

const KEY = 'tabterm.pageShortcuts';

/**
 * Combinations macOS Chrome keeps for itself.
 *
 * Some never reach a page at all, and some reach it having already done something. Both are
 * unusable, and the difference does not matter to somebody trying to bind one. Listed rather
 * than detected, because there is no API that answers this question. See
 * `docs/10-limitations.md` tier 0.4.
 */
const RESERVED = new Set([
  'Meta+W',
  'Meta+T',
  'Meta+N',
  'Meta+Q',
  'Meta+L',
  'Meta+R',
  'Meta+D',
  'Meta+F',
  'Meta+P',
  'Meta+S',
  'Meta+O',
  'Meta+H',
  'Meta+M',
  'Meta+Y',
  'Meta+,',
  'Shift+Meta+T',
  'Shift+Meta+N',
  'Shift+Meta+Q',
  'Shift+Meta+M',
  'Meta+1',
  'Meta+2',
  'Meta+3',
  'Meta+4',
  'Meta+5',
  'Meta+6',
  'Meta+7',
  'Meta+8',
  'Meta+9',
  'Meta+0',
]);

/** The canonical written form, so two ways of pressing the same keys compare equal. */
export function describeKeys(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string {
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}

/** The same thing as a keyboard would show it, for reading rather than for comparing. */
export function prettyKeys(keys: string): string {
  if (keys === '') return 'not bound';
  return keys
    .replace('Control+', '⌃')
    .replace('Alt+', '⌥')
    .replace('Shift+', '⇧')
    .replace('Meta+', '⌘');
}

/**
 * Why a combination cannot be used, or null when it can.
 *
 * A bare key or a key with only Shift is refused for a different reason than a reserved one: it
 * would be typed into the shell, and a terminal that eats a letter is worse than one with no
 * shortcut at all.
 */
export function whyNot(keys: string): string | null {
  if (keys === '') return null;
  if (RESERVED.has(keys)) return 'Chrome keeps this one for itself, so the page never sees it.';
  const hasModifier = /Control\+|Alt\+|Meta\+/.test(keys);
  if (!hasModifier) return 'This would be typed into the shell rather than caught here.';
  // Control alone belongs to the shell: Control C, Control D, Control Z and the rest.
  if (/^Control\+[A-Za-z]$/.test(keys)) return 'The shell needs every plain Control key.';
  return null;
}

/**
 * The id under which a key bound to an action somebody made is stored.
 *
 * Prefixed rather than kept in a second list, so that everything bindable is one list with one
 * clash check. Two lists would need a third thing to compare them, and the first time it was
 * forgotten the same keys would be bound to two different jobs.
 */
export const ACTION_PREFIX = 'action:';

export function actionShortcutId(actionId: string): string {
  return `${ACTION_PREFIX}${actionId}`;
}

/** The action an id names, or null when the id is one of the built-in page shortcuts. */
export function actionIdFrom(shortcutId: string): string | null {
  return shortcutId.startsWith(ACTION_PREFIX) ? shortcutId.slice(ACTION_PREFIX.length) : null;
}

/**
 * The shipped list with stored keys applied, plus a row for each action somebody made.
 *
 * The actions are passed in rather than read here, because this module knows about keys and
 * nothing about what an action is. An action that has been deleted takes its binding with it:
 * a key bound to something that no longer exists is a key that does nothing, and it would go on
 * blocking that combination for everything else.
 */
export function parseShortcuts(
  raw: unknown,
  actions: readonly { id: string; name: string }[] = [],
): PageShortcut[] {
  const stored = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const s = item as Partial<PageShortcut>;
      if (typeof s.id === 'string' && typeof s.keys === 'string') stored.set(s.id, s.keys);
    }
  }
  // Always the shipped list, with stored keys applied. A stored entry for something that no
  // longer exists disappears, and something new appears with its default rather than unbound.
  const shipped = DEFAULT_PAGE_SHORTCUTS.map((d) => ({ ...d, keys: stored.get(d.id) ?? d.keys }));
  const mine = actions.map((action) => ({
    id: actionShortcutId(action.id),
    title: action.name,
    keys: stored.get(actionShortcutId(action.id)) ?? '',
  }));
  return [...shipped, ...mine];
}

export async function loadShortcuts(
  actions: readonly { id: string; name: string }[] = [],
): Promise<PageShortcut[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return parseShortcuts(stored[KEY], actions);
  } catch {
    return parseShortcuts(undefined, actions);
  }
}

export async function saveShortcuts(shortcuts: readonly PageShortcut[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: shortcuts.map(({ id, keys }) => ({ id, keys })) });
  } catch {
    // A binding that could not be saved is worth less than the terminal still working.
  }
}
