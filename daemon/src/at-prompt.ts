/**
 * The bytes that run a command at a prompt somebody may already have typed on.
 *
 * With TabTerm's zsh integration, Escape q is zsh's `push-line`: the line is set aside, the
 * command runs on an empty one, and zsh puts the line back at the next prompt, whether the
 * command worked or not. Asked for: "maybe we can have it actually keep what was typed in the
 * terminal input command box for after the cd has been completed". The integration binds it in
 * the vi keymaps too, since only emacs has it by default.
 *
 * Without the integration the shell may not be zsh, so the line is cleared instead: Control E
 * goes to its end and Control U removes everything before it, in bash and zsh alike. What was
 * typed is lost, which is still better than running it.
 */
const PUSH_LINE = '\u001bq';
const END_OF_LINE = '\u0005';
const CLEAR_TO_START = '\u0015';

export function atPrompt(command: string, integrated: boolean): string {
  const setAside = integrated ? PUSH_LINE : END_OF_LINE + CLEAR_TO_START;
  return `${setAside}${command}\r`;
}
