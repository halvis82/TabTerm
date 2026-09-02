import { openColorPicker } from './color-picker.js';

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
  /**
   * Fired on every keystroke and every color, so the name can be drawn as it is typed.
   *
   * A name is a piece of visual design: how big it looks against this pane, whether the color
   * reads at low opacity, whether it wraps. None of that can be judged from a text box, and
   * having to save, look, and reopen to adjust it is three steps for one decision.
   */
  onPreview?: (label: string, color: string) => void;
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

  /**
   * The picker is always there, under the box.
   *
   * Naming a session and describing a landmark are both "type a word and pick a color", so both
   * halves belong on screen at once. Hiding the color behind a swatch made choosing one two
   * clicks for something that is half the form.
   */
  const colors = document.createElement('div');
  colors.className = 'pane-label-colors';
  openColorPicker({
    anchor: colors,
    inline: true,
    recents,
    current: chosen,
    onPick: (color) => {
      chosen = color;
      opts.onPreview?.(input.value, chosen);
      input.focus();
    },
  });

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
    // Escape and Command+K are handled once on the document, in the capture phase, so the form
    // goes the same way whatever has focus. A capture listener has already run by the time
    // `stopPropagation` above takes effect, so both still reach it.
    if (e.key === 'Enter') opts.onSubmit(input.value, chosen);
  });
  // `input` rather than `keydown`, so it fires after the character has landed and also catches
  // a paste, which produces no keystroke at all.
  input.addEventListener('input', () => opts.onPreview?.(input.value, chosen));

  form.append(input, colors, actions);
  opts.container.append(form);

  /**
   * Anything else that happens dismisses it, and dismissing means cancel.
   *
   * A small form floating over a terminal is not a dialog and should not behave like one:
   * clicking somewhere else, pressing Escape, or opening the command menu all plainly mean "not
   * now". Only Escape typed inside the box was handled, so clicking away left the form sitting
   * there over the terminal with no obvious way out but the button.
   *
   * Cancel, never save. A name that was already set stays what it was, and a marker that was
   * being described is simply not added. Saving something half typed because attention moved
   * elsewhere would be worse than losing it.
   */
  const dismiss = (): void => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    opts.onCancel();
  };
  const onDown = (e: MouseEvent): void => {
    if (!(e.target instanceof Node)) return;
    // The color picker is a separate element, and clicking a color is using the form.
    if (form.contains(e.target)) return;
    if (document.querySelector('.color-picker')?.contains(e.target) === true) return;
    dismiss();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dismiss();
    // The command menu takes over the screen, so leaving this underneath it is clutter.
    if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) dismiss();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  input.focus();
  input.select();
  return form;
}
