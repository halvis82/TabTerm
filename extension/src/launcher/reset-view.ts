import type { LiveSession } from '@tabterm/shared';

/**
 * The confirmation in front of the reset.
 *
 * A menu item that ended every terminal on click would be a trap: the entry sits next to
 * "Settings" on the same icon, and the cost of a misclick is somebody's running work. So the
 * menu opens this, and this asks.
 *
 * It says what will be destroyed in numbers rather than in general terms, because "are you
 * sure" is a question nobody can answer without them.
 */

export interface ResetOptions {
  sessions: readonly LiveSession[];
  tabCount: number;
  onCancel: () => void;
  onConfirm: (restartDaemon: boolean) => void;
}

export function buildReset(options: ResetOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'reset';

  const card = document.createElement('section');
  card.className = 'reset-card';

  const title = document.createElement('h1');
  title.className = 'reset-title';
  title.textContent = 'Reset TabTerm';
  card.append(title);

  const body = document.createElement('p');
  body.className = 'reset-body';
  const running = options.sessions.length;
  const busy = options.sessions.filter((s) => s.busy).length;
  body.textContent =
    running === 0
      ? 'Nothing is running. This will clear stored history and start clean.'
      : `This ends ${count(running, 'terminal session')} and closes ${count(
          options.tabCount,
          'tab',
        )}. Anything still running is stopped.`;
  card.append(body);

  if (busy > 0) {
    // The one fact most likely to change somebody's mind, so it is not buried in the sentence
    // above with everything else.
    const warning = document.createElement('p');
    warning.className = 'reset-warning';
    warning.textContent = `${count(busy, 'session')} currently running a command.`;
    card.append(warning);
  }

  const list = document.createElement('ul');
  list.className = 'reset-list';
  for (const line of [
    'Every terminal process is ended',
    'Stored history for every session is deleted',
    'Every TabTerm tab is closed',
  ]) {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
  }
  card.append(list);

  const restart = document.createElement('label');
  restart.className = 'reset-option';
  const restartBox = document.createElement('input');
  restartBox.type = 'checkbox';
  restartBox.checked = true;
  const restartText = document.createElement('span');
  restartText.textContent = 'Also restart the background service';
  const restartNote = document.createElement('small');
  restartNote.textContent = 'Replaces the daemon and the process holding the terminals';
  restartText.append(restartNote);
  restart.append(restartBox, restartText);
  card.append(restart);

  const buttons = document.createElement('div');
  buttons.className = 'reset-buttons';

  const cancel = document.createElement('button');
  cancel.className = 'reset-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', options.onCancel);

  const confirm = document.createElement('button');
  confirm.className = 'reset-confirm';
  confirm.textContent = running === 0 ? 'Reset' : `End ${count(running, 'session')}`;
  confirm.addEventListener('click', () => options.onConfirm(restartBox.checked));

  // Cancel first in the DOM so it takes focus, and so the destructive one is never the default.
  buttons.append(cancel, confirm);
  card.append(buttons);

  wrap.append(card);
  // Escape is what people press to get out of something like this.
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') options.onCancel();
  });
  setTimeout(() => cancel.focus(), 0);
  return wrap;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** What the page shows once it is done, before it closes itself. */
export function buildResetDone(sessionsEnded: number, restarting: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'reset';
  const card = document.createElement('section');
  card.className = 'reset-card';
  const title = document.createElement('h1');
  title.className = 'reset-title';
  title.textContent = 'Reset';
  const body = document.createElement('p');
  body.className = 'reset-body';
  body.textContent = restarting
    ? `${count(sessionsEnded, 'session')} ended. The background service is restarting.`
    : `${count(sessionsEnded, 'session')} ended.`;
  card.append(title, body);
  wrap.append(card);
  return wrap;
}
