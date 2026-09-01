import { openColorPicker, closeColorPicker } from './color-picker.js';

/**
 * Naming a session, and describing a landmark.
 *
 * A text box and a color, opened from the pane's own menu and dismissed by Escape or by clicking
 * away. Deliberately small: a name and a tint is the whole feature, and anything more would be a
 * dialog in front of a terminal.
 *
 * The color is chosen with the same picker the highlight uses, rather than from six fixed tints.
 * The fixed set was enough to tell panes apart and was never enough for anything anybody meant
 * by "that one, but darker". The last few colors are offered inside the picker, per use, so the
 * common case is still one click on a color already known to work.
 */

export interface LabelFormOptions {
  container: HTMLElement;
  /** What the box is for, since the same form names a session and describes a marker. */
  placeholder?: string;
  current: string;
  currentColor?: string;
  /** The last few colors chosen for this particular use. */
  recents?: readonly string[];
  onSubmit: (label: string, color: string) => void;
  onCancel: () => void;
}

export function openLabelForm(opts: LabelFormOptions): HTMLElement {
  document.querySelector('.pane-label-form')?.remove();

  const form = document.createElement('div');
  form.className = 'pane-label-form';

  const input = document.createElement('input');
  input.className = 'pane-label-input';
  input.placeholder = opts.placeholder ?? 'Name this session';
  input.maxLength = 40;
  input.value = opts.current;
  input.spellcheck = false;

  const recents = opts.recents ?? [];
  let chosen = opts.currentColor ?? recents[0] ?? '#9aa1b8';

  const swatches = document.createElement('div');
  swatches.className = 'pane-label-colors';

  const current = document.createElement('button');
  current.className = 'pane-label-color on';
  current.style.background = chosen;
  current.title = 'Choose a color';

  const caption = document.createElement('span');
  caption.className = 'pane-label-color-caption';
  caption.textContent = 'Color';

  current.addEventListener('mousedown', (e) => e.stopPropagation());
  current.addEventListener('click', (e) => {
    e.stopPropagation();
    openColorPicker({
      anchor: current,
      recents,
      current: chosen,
      onPreview: (color) => (current.style.background = color),
      onPick: (color) => {
        chosen = color;
        current.style.background = color;
        closeColorPicker();
        input.focus();
      },
      // Nothing was chosen, so the swatch goes back to showing what is still selected.
      onClose: () => (current.style.background = chosen),
    });
  });
  swatches.append(caption, current);

  const actions = document.createElement('div');
  actions.className = 'pane-label-actions';

  const save = document.createElement('button');
  save.className = 'term-menu-item';
  save.textContent = 'Save';
  save.addEventListener('click', () => opts.onSubmit(input.value, chosen));

  // Offered only when there is one, so the form does not advertise an action that does nothing.
  if (opts.current !== '') {
    const clear = document.createElement('button');
    clear.className = 'term-menu-item';
    clear.textContent = 'Remove';
    clear.addEventListener('click', () => opts.onSubmit('', chosen));
    actions.append(clear);
  }
  actions.append(save);

  input.addEventListener('keydown', (e) => {
    // The terminal is underneath and would otherwise receive every one of these.
    e.stopPropagation();
    if (e.key === 'Enter') opts.onSubmit(input.value, chosen);
    if (e.key === 'Escape') opts.onCancel();
  });

  form.append(input, swatches, actions);
  opts.container.append(form);
  input.focus();
  input.select();
  return form;
}
