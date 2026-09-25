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
import { isTypedAtMenu, MenuTyping } from './menu-typing.js';

/** An empty menu, not yet placed and not yet on screen. Fill it, then `place` it. */
export function menuShell(): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'term-menu';
  return menu;
}

/**
 * Put it where it fits, show it, and arm the dismissal. Returns the way to close it.
 *
 * Measured first: the size depends on the entries, and the entries depend on what was clicked,
 * so there is no useful constant to place it by.
 */
export function placeAndArm(menu: HTMLElement, x: number, y: number): () => void {
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
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', leave);
    document.removeEventListener('visibilitychange', leave);
  };

  /**
   * Escape closes the menu, and the terminal never hears about it.
   *
   * Swallowed rather than merely acted on, which is the whole point. Escape is how a menu is
   * dismissed everywhere, and it is also the interrupt key of every agent CLI this product hosts.
   * With the menu open and the keystroke reaching the pane underneath, pressing it to put the menu
   * away stopped an agent mid-answer. Reported exactly that way: "i just accidentally cut claude
   * off because i pressed esc to close the right click menu".
   *
   * At the capture phase on `window`, which is the outermost node and therefore before anything
   * else in the page and long before the emulator's own handler on its textarea.
   * `stopImmediatePropagation` as well, because another listener on `window` would otherwise still
   * see it.
   */
  /**
   * An open menu owns the keyboard.
   *
   * Typing at it picks an entry, the way every native menu on this machine behaves: `n` lands on
   * the first entry beginning with `n`, `name` narrows to the one that is, Return runs it. Asked
   * for exactly that way, with the condition that matters most: "it's important that those
   * characters typed when the menu is open does not go to the terminal".
   *
   * So everything is swallowed while the menu is up, including the keys that land on nothing.
   * A menu that eats `n` and passes `z` through to a shell is worse than one that eats neither,
   * because the difference is invisible until something has already run.
   */
  const typing = new MenuTyping();
  // Buttons only: a menu can hold a label that looks like an entry and does nothing when pressed.
  const entries = (): HTMLButtonElement[] => [
    ...menu.querySelectorAll<HTMLButtonElement>('button.term-menu-item'),
  ];

  /** Outline one entry and no other, and bring it into view if the menu is scrolling. */
  const pick = (index: number): void => {
    const items = entries();
    for (const [i, item] of items.entries()) item.classList.toggle('is-picked', i === index);
    items[index]?.scrollIntoView({ block: 'nearest' });
  };

  const move = (by: number): void => {
    const items = entries().filter((item) => !item.disabled);
    if (items.length === 0) return;
    const at = items.findIndex((item) => item.classList.contains('is-picked'));
    const next = items[(at + by + items.length * 2) % items.length];
    for (const item of entries()) item.classList.toggle('is-picked', item === next);
    next?.scrollIntoView({ block: 'nearest' });
  };

  const onKey = (e: KeyboardEvent): void => {
    /**
     * A menu that has already gone owns nothing.
     *
     * Choosing an entry removes the element, and the listeners outlive it: dismissal is armed on
     * `mousedown` and excuses clicks inside the menu, which is exactly what choosing one is. That
     * cost nothing while this only swallowed Escape. It costs everything now that it swallows
     * what is typed, because the next thing somebody types is usually into the box the entry they
     * chose has just opened.
     */
    if (!menu.isConnected) {
      close();
      return;
    }
    const eat = (): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.key === 'Escape') {
      eat();
      close();
      return;
    }
    if (e.key === 'Enter') {
      eat();
      const chosen = entries().find((item) => item.classList.contains('is-picked'));
      // Nothing picked means nothing to run. The menu stays, rather than guessing at an entry.
      if (chosen && !chosen.disabled) chosen.click();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      eat();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Backspace') {
      eat();
      const items = entries();
      pick(
        typing.backspace(
          items.map((item) => item.textContent ?? ''),
          items.map((item) => !item.disabled),
        ),
      );
      return;
    }
    if (isTypedAtMenu(e.key, e.ctrlKey, e.metaKey, e.altKey)) {
      eat();
      const items = entries();
      pick(
        typing.type(
          e.key,
          items.map((item) => item.textContent ?? ''),
          Date.now(),
          items.map((item) => !item.disabled),
        ),
      );
      return;
    }
    /*
     * Everything else is swallowed too, and deliberately does nothing.
     *
     * Tab would move the focus out of a menu that is about to be removed, and a shortcut with a
     * modifier would act on the terminal behind a menu somebody is still reading.
     */
    eat();
  };

  /**
   * And leaving takes it with you.
   *
   * A menu is about a place on a page. Going to another tab or another window and coming back to
   * find it still sitting there is a menu about a moment that has passed, and the next click lands
   * on an entry somebody opened for something else. Both events are listened for: changing tab
   * hides the page, changing window only blurs it.
   */
  const leave = (): void => close();

  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('contextmenu', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', leave);
  }, 0);

  /*
   * Handed back, so an entry that has just been chosen can put the menu away and take its
   * listeners with it. Removing the element alone would leave those armed against a menu that is
   * no longer there.
   */
  return () => close();
}

/** One entry. `enabled: false` greys it rather than hiding it, so the menu keeps its shape. */
export interface ShellItem {
  label: string;
  run: () => void;
  enabled?: boolean;
  separated?: boolean;
  danger?: boolean;
  /**
   * The keys that do the same thing, as a keyboard shows them.
   *
   * A menu is where somebody looks the first few times, and the shortcut is how they stop needing
   * to. Printing it here is the only place the two ever meet. Absent rather than "not bound" for
   * an entry with no key, because a menu is not a settings screen and a column of "not bound" is
   * noise on every line that has nothing to say.
   */
  keys?: string;
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
    /*
     * An attribute drawn by CSS rather than a child element, so the label stays the whole of
     * `textContent`. That is what an entry is matched by everywhere, including by the checks that
     * drive this menu with a real press.
     */
    if (entry.keys !== undefined && entry.keys !== '') button.dataset['keys'] = entry.keys;
    button.disabled = entry.enabled === false;
    button.addEventListener('click', () => {
      menu.remove();
      entry.run();
    });
    menu.append(button);
  }
}
