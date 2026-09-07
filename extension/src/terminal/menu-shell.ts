/**
 * The box a right-click menu is drawn in, and the rules for getting rid of it.
 *
 * Extracted because a right click anywhere in TabTerm now opens a TabTerm menu, and the terminal
 * is no longer the only place that draws one. What differs between them is the list of entries.
 * What must not differ is any of this: where the box lands when the click was near an edge, that
 * pressing an entry does not dismiss the menu before the press completes, and that the next click
 * anywhere else puts it away.
 *
 * That second rule is the one worth stating. Dismissal runs on `mousedown` in the capture phase,
 * so without the exception for clicks inside the menu, pressing an entry removed the button
 * before the release, and a click is only dispatched when press and release land on the same
 * element. No entry ever ran. It survived every test, because a synthetic `element.click()`
 * dispatches the click directly and never produces the mousedown that caused it.
 */
import { placeMenu } from './menu-position.js';

/** An empty menu, not yet placed and not yet on screen. Fill it, then `place` it. */
export function menuShell(): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'term-menu';
  return menu;
}

/**
 * Put it where it fits, show it, and arm the dismissal.
 *
 * Measured first: the size depends on the entries, and the entries depend on what was clicked,
 * so there is no useful constant to place it by.
 */
export function placeAndArm(menu: HTMLElement, x: number, y: number): void {
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const at = placeMenu({
    x,
    y,
    menuWidth: rect.width,
    menuHeight: rect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  menu.style.left = `${String(at.left)}px`;
  menu.style.top = `${String(at.top)}px`;
  menu.style.visibility = 'visible';

  const close = (e?: Event): void => {
    if (e && e.target instanceof Node && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
    document.removeEventListener('contextmenu', close, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('contextmenu', close, true);
  }, 0);
}

/** One entry. `enabled: false` greys it rather than hiding it, so the menu keeps its shape. */
export interface ShellItem {
  label: string;
  run: () => void;
  enabled?: boolean;
  separated?: boolean;
  danger?: boolean;
}

/** Fill a shell from a list. The terminal builds its own, because its entries are richer. */
export function fillMenu(menu: HTMLElement, items: readonly ShellItem[]): void {
  for (const entry of items) {
    if (entry.separated === true) {
      const rule = document.createElement('div');
      rule.className = 'term-menu-rule';
      menu.append(rule);
    }
    const button = document.createElement('button');
    button.className = 'term-menu-item';
    if (entry.danger === true) button.classList.add('is-danger');
    button.textContent = entry.label;
    button.disabled = entry.enabled === false;
    button.addEventListener('click', () => {
      menu.remove();
      entry.run();
    });
    menu.append(button);
  }
}
