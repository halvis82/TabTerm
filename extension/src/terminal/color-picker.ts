import { colorAt, mapBackground } from './color-map.js';

/**
 * One color picker, everywhere a color is chosen.
 *
 * Click anywhere on the map. There is nothing to type, no channels, and no second dialog: the
 * whole thing is a rectangle you point at, plus the last few colors as a row of swatches, because
 * the common case is reusing a color rather than finding a new one.
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
}

export function openColorPicker(opts: ColorPickerOptions): HTMLElement {
  document.querySelector('.color-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'color-picker';

  const map = document.createElement('div');
  map.className = 'color-picker-map';
  map.style.background = mapBackground();

  const colorFor = (e: MouseEvent): string => {
    const box = map.getBoundingClientRect();
    return colorAt((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
  };

  map.addEventListener('mousemove', (e) => opts.onPreview?.(colorFor(e)));
  // On mouseup rather than click: the map is inside a menu that closes on mousedown elsewhere,
  // and a press that begins here must be the one that decides.
  map.addEventListener('mouseup', (e) => {
    e.stopPropagation();
    opts.onPick(colorFor(e));
  });
  map.addEventListener('mousedown', (e) => e.stopPropagation());

  const row = document.createElement('div');
  row.className = 'color-picker-recents';
  for (const color of opts.recents) {
    const swatch = document.createElement('button');
    swatch.className = 'color-picker-swatch';
    swatch.style.background = color;
    swatch.title = color;
    swatch.classList.toggle('on', color.toLowerCase() === (opts.current ?? '').toLowerCase());
    swatch.addEventListener('mousedown', (e) => e.stopPropagation());
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onPick(color);
    });
    row.append(swatch);
  }

  picker.append(map, row);
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
