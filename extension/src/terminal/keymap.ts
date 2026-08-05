/**
 * Which keystrokes belong to the terminal, and which belong to the page.
 *
 * The distinction people actually care about on macOS: **Control keys reach the shell,
 * Command keys do not.** `Ctrl+C` must interrupt, and `Cmd+C` must copy without interrupting
 * anything. Getting that backwards, in either direction, is the difference between a terminal
 * and a text box that looks like one.
 *
 * Kept pure so it can be tested without a renderer or a browser.
 * See docs/07-terminal-fidelity.md.
 */

export type KeyAction =
  | { kind: 'to-pty' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'select-all' }
  | { kind: 'clear' }
  | { kind: 'search' }
  | { kind: 'browser' };

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  type: string;
  /** Whether anything is selected right now, which changes what Command+C should mean. */
  hasSelection: boolean;
}

/**
 * Decide what a keystroke means.
 *
 * `to-pty` is the default on purpose. Anything not deliberately claimed here belongs to the
 * shell, because a terminal that silently swallows keys is worse than one that passes through
 * something the page might have wanted.
 */
export function classifyKey(e: KeyInput): KeyAction {
  if (e.type !== 'keydown') return { kind: 'to-pty' };

  // Control is the shell's. Every Ctrl+letter goes straight through, including Ctrl+C, which
  // must interrupt rather than copy.
  if (e.ctrlKey && !e.metaKey) return { kind: 'to-pty' };

  if (e.metaKey) {
    const key = e.key.toLowerCase();
    switch (key) {
      case 'c':
        // With nothing selected there is nothing to copy, so let Chrome have it rather than
        // eating the keystroke. It never reaches the shell either way.
        return e.hasSelection ? { kind: 'copy' } : { kind: 'browser' };
      case 'v':
        return { kind: 'paste' };
      case 'a':
        return { kind: 'select-all' };
      case 'k':
        return { kind: 'clear' };
      case 'f':
        return { kind: 'search' };
      default:
        // Command+W, Command+T, Command+number and the rest are Chrome's, and in a normal tab
        // they never reach the page at all. See docs/10-limitations.md tier 0.4.
        return { kind: 'browser' };
    }
  }

  return { kind: 'to-pty' };
}

/**
 * Should xterm handle this key itself?
 *
 * xterm's custom handler uses this convention: returning false means "I have dealt with it",
 * and true means "carry on and send it to the PTY".
 */
export function xtermShouldHandle(action: KeyAction): boolean {
  return action.kind === 'to-pty';
}
