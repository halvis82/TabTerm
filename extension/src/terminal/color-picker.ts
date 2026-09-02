import { colorAt, mapBackground } from './color-map.js';

/**
 * One color picker, everywhere a color is chosen.
 *
 * Three parts, always in the same order and the same shape wherever it appears:
 *
 *     [        the color as it stands        ]
 *     [                                      ]
 *     [              the map                 ]
 *     [                                      ]
 *     []  []  []  []  []
 *
 * The bar on top is what is currently chosen, and it follows the pointer across the map, so the
 * color can be judged at a size worth judging rather than as a dot under the cursor. Under the
 * map are the last five colors used **for this particular job**, filling left to right.
 *
 * Choosing is one click. There is no confirmation step, because a color is not a decision worth
 * asking twice about and putting it back is one more click.
 *
 * It replaced three fixed palettes. Six preset tints were enough to tell panes apart and were
 * never enough for anything a person actually meant by "that one, but darker".
 */

export interface ColorPickerOptions {
  /** The element to sit beside, usually the swatch that opened it. */
  anchor: HTMLElement;
  recents: readonly string[];
  current?: string;
  /** Fired live as the pointer moves, so the choice can be previewed. */
  onPreview?: (color: string) => void;
  onPick: (color: string) => void;
  onClose?: () => void;
  /** Placed inside the anchor and left there, rather than floating beside it. */
  inline?: boolean;
}

export function openColorPicker(opts: ColorPickerOptions): HTMLElement {
  document.querySelector('.color-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'color-picker';
  if (opts.inline === true) picker.classList.add('is-inline');

  // What is chosen, big enough to actually see. It previews the pointer's color while the
  // pointer is over the map, and goes back to the chosen one when it leaves.
  const bar = document.createElement('div');
  bar.className = 'color-picker-current';
  const settled = opts.current ?? '#9aa1b8';
  bar.style.background = settled;

  const map = document.createElement('div');
  map.className = 'color-picker-map';
  map.style.background = mapBackground();

  const colorFor = (e: MouseEvent): string => {
    const box = map.getBoundingClientRect();
    return colorAt((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
  };

  map.addEventListener('mousemove', (e) => {
    const color = colorFor(e);
    bar.style.background = color;
    opts.onPreview?.(color);
  });
  map.addEventListener('mouseleave', () => {
    bar.style.background = settled;
    opts.onPreview?.(settled);
  });
  // On mouseup rather than click: the map is inside a menu that closes on mousedown elsewhere,
  // and a press that begins here must be the one that decides.
  map.addEventListener('mouseup', (e) => {
    e.stopPropagation();
    opts.onPick(colorFor(e));
  });
  map.addEventListener('mousedown', (e) => e.stopPropagation());

  /**
   * Five slots, filled left to right, and never a sixth.
   *
   * A row that grows is a row whose contents move, and a color picked by position is worth
   * having only if the positions hold still. Empty slots are drawn as empty rather than left
   * out, so the row is the same shape from the first use.
   */
  const row = document.createElement('div');
  row.className = 'color-picker-recents';
  const slots = opts.recents.slice(0, 5);
  while (slots.length < 5) slots.push('');
  for (const color of slots) {
    if (color === '') {
      const empty = document.createElement('span');
      empty.className = 'color-picker-swatch is-empty';
      row.append(empty);
      continue;
    }
    const swatch = document.createElement('button');
    swatch.className = 'color-picker-swatch';
    swatch.style.background = color;
    swatch.title = color;
    // Nothing is marked as selected. The bar at the top already says what is chosen, and a
    // second indicator saying the same thing only makes the row noisier.
    swatch.addEventListener('mousedown', (e) => e.stopPropagation());
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onPick(color);
    });
    row.append(swatch);
  }

  picker.append(bar, map, row);

  /**
   * Inline sits in the form it belongs to. Floating sits beside whatever opened it.
   *
   * The name and the marker both show it permanently next to their text box, because choosing a
   * color is part of what those forms are for. The highlight menu opens it only when its swatch
   * is pressed, because highlighting is one click and the color is the exception.
   */
  if (opts.inline === true) {
    opts.anchor.append(picker);
    return picker;
  }

  document.body.append(picker);
  // Measured then placed, like the menu: the anchor can be anywhere, including against an edge.
  const box = picker.getBoundingClientRect();
  const at = opts.anchor.getBoundingClientRect();
  const left = Math.min(Math.max(4, at.right + 6), window.innerWidth - box.width - 4);
  const top = Math.min(Math.max(4, at.top), window.innerHeight - box.height - 4);
  picker.style.left = `${String(left)}px`;
  picker.style.top = `${String(top)}px`;

  const close = (e?: Event): void => {
    if (e && e.target instanceof Node && picker.contains(e.target)) return;
    picker.remove();
    document.removeEventListener('mousedown', close, true);
    opts.onClose?.();
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  return picker;
}

export function closeColorPicker(): void {
  document.querySelector('.color-picker')?.remove();
}
