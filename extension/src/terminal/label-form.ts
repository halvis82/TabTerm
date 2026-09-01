/**
 * Naming a pane.
 *
 * A text box and a handful of colors, opened from the pane's own menu and dismissed by Escape or
 * by clicking away. Deliberately small: a name and a tint is the whole feature, and anything more
 * would be a dialog in front of a terminal.
 *
 * The colors are a fixed set rather than a full picker. Six distinguishable tints is what telling
 * panes apart actually needs, and a free color wheel mostly produces labels nobody can read
 * against the terminal background.
 */

export const LABEL_COLORS = [
  '#9aa1b8', // the default grey, for a label that should stay out of the way
  '#7aa2f7',
  '#8ae2a0',
  '#e0c879',
  '#e0776b',
  '#c58af0',
] as const;

export interface LabelFormOptions {
  container: HTMLElement;
  /** What the box is for, since the same form names a session and describes a marker. */
  placeholder?: string;
  current: string;
  currentColor?: string;
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

  let chosen = opts.currentColor ?? LABEL_COLORS[0];

  const swatches = document.createElement('div');
  swatches.className = 'pane-label-colors';
  const buttons: HTMLButtonElement[] = [];
  for (const color of LABEL_COLORS) {
    const swatch = document.createElement('button');
    swatch.className = 'pane-label-color';
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener('click', () => {
      chosen = color;
      for (const b of buttons) b.classList.toggle('on', b === swatch);
      input.focus();
    });
    swatch.classList.toggle('on', color === chosen);
    buttons.push(swatch);
    swatches.append(swatch);
  }

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
