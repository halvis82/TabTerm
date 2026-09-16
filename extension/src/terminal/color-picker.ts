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

  /**
   * Held down, the map is followed rather than sampled once.
   *
   * Asked for: "i want to be able to hold my mouse down while selecting the color and see it
   * update... and if held and moved off the color map, it should just keep the selection at the
   * last color touched."
   *
   * So a press is a drag with a live answer, and what is shown while dragging is what is chosen on
   * release. Leaving the map with the button down keeps the last colour rather than snapping back,
   * because somebody dragging past the edge has not changed their mind, and releasing outside
   * commits that colour rather than throwing the whole gesture away.
   */
  let pressing = false;
  let lastTouched = settled;

  const showColor = (color: string): void => {
    lastTouched = color;
    bar.style.background = color;
    opts.onPreview?.(color);
  };

  const inside = (e: MouseEvent): boolean => {
    const box = map.getBoundingClientRect();
    return (
      e.clientX >= box.left &&
      e.clientX <= box.right &&
      e.clientY >= box.top &&
      e.clientY <= box.bottom
    );
  };

  map.addEventListener('mousemove', (e) => {
    if (!pressing) showColor(colorFor(e));
  });
  map.addEventListener('mouseleave', () => {
    // Only when nothing is being dragged. Mid-drag the last colour stands.
    if (!pressing) showColor(settled);
  });

  map.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    pressing = true;
    showColor(colorFor(e));
  });

  /*
   * Followed on the document rather than on the map, because the pointer leaves it.
   *
   * A drag that goes outside keeps the last colour it touched, which is what the map stops being
   * able to report the moment the pointer is past its edge.
   */
  const detachDrag = (): void => {
    document.removeEventListener('mousemove', followWhilePressed, true);
    document.removeEventListener('mouseup', commitOnRelease, true);
  };
  /*
   * The listeners take themselves off once the picker is gone.
   *
   * There are two ways it goes: the floating one closes on a press elsewhere, and either kind can
   * be removed outright by `closeColorPicker`. Rather than teach both about these, they check
   * whether the element they belong to is still in the document, which is true however it left.
   */
  function followWhilePressed(e: MouseEvent): void {
    if (!picker.isConnected) {
      detachDrag();
      return;
    }
    if (pressing && inside(e)) showColor(colorFor(e));
  }
  function commitOnRelease(e: MouseEvent): void {
    if (!picker.isConnected) {
      detachDrag();
      return;
    }
    if (!pressing) return;
    pressing = false;
    e.stopPropagation();
    opts.onPick(lastTouched);
  }
  document.addEventListener('mousemove', followWhilePressed, true);
  document.addEventListener('mouseup', commitOnRelease, true);

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
