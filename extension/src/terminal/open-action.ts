import type { OpenHow, ResolvedPath } from '@tabterm/shared';

/**
 * Which action a click on a path means.
 *
 * Kept in its own module with no side effects so it can be tested directly. The terminal page
 * touches `location` and the DOM at import time, which would make importing it from a test
 * fail before a single assertion ran.
 *
 * Command is already required for a link to be live at all, so the extra modifier held
 * alongside it selects what happens. See docs/06-chrome-integration.md.
 */
export function chooseOpenAction(resolved: ResolvedPath, event: MouseEvent): OpenHow {
  // Opening a terminal is the least destructive choice, so it wins when several are held.
  if (event.shiftKey) return 'new-terminal';
  // There is no sensible "open this folder in an editor", so a directory always reveals.
  if (resolved.isDirectory) return 'reveal-in-finder';
  if (event.altKey) return 'editor';
  if (event.ctrlKey) return 'gui-editor';
  return 'default-app';
}

export function describeOpen(how: OpenHow): string {
  switch (how) {
    case 'editor':
      return 'Opening in your editor:';
    case 'gui-editor':
      return 'Opening in your GUI editor:';
    case 'new-terminal':
      return 'Opening a terminal at';
    case 'reveal-in-finder':
      return 'Revealing';
    case 'default-app':
      return 'Opening';
  }
}
