import { THEME_CHOICES } from '../terminal/themes.js';
import { describeKeys, prettyKeys } from '../terminal/page-shortcuts.js';
import type { AgentHooksStatus, NotifyPolicy, ShellIntegrationStatus } from '@tabterm/shared';
/**
 * Settings, reached from the gear in the panel's footer.
 *
 * Only what TabTerm actually controls. Chrome owns the shortcut that opens a terminal when no
 * terminal has focus -- an extension cannot rebind that, and only `chrome://extensions/shortcuts`
 * can, so this links there and says why rather than offering a control that would not work.
 * Everything that happens *inside* a tab is ours and is listed here.
 */

export interface SettingsOptions {
  onChangeTheme: (theme: string) => void;
  /** Current notification policy, or null until the daemon has answered. */
  notify: () => NotifyPolicy | null;
  onChangeNotify: (policy: Partial<NotifyPolicy>) => void;
  agentHooks: () => AgentHooksStatus | null;
  onChangeAgentHooks: (enabled: boolean) => void;
  /** What "launch an agent" runs, as typed. Null until the daemon has answered. */
  agentCommand: () => string | null;
  onChangeAgentCommand: (command: string) => void;
  shellIntegration: () => ShellIntegrationStatus | null;
  onChangeShellIntegration: (enabled: boolean) => void;
  /** Bytes of output kept per session, across every copy of it. Null until the daemon answers. */
  scrollbackBytes: () => number | null;
  onChangeScrollback: (bytes: number) => void;
  /** Seconds a session with no tab is kept, null for forever, undefined until the daemon says. */
  backgroundTimeout: () => number | null | undefined;
  onChangeBackgroundTimeout: (seconds: number | null) => void;
  /** Templates that have been deleted or changed since they shipped, if any. */
  /** The keys this page answers to, and a way to change one. */
  pageShortcuts: () => readonly { id: string; title: string; keys: string }[];
  onRebind: (id: string, keys: string) => string | null;
  alteredTemplates: () => number;
  onRestoreTemplates: () => void;
  onRestoreSettings: () => void;
  onEraseEverything: () => void;
}

/**
 * How long a terminal with no tab is kept.
 *
 * Forever is last rather than first: it is a real answer and was the old behavior, but it is
 * the one that quietly accumulates hundreds of shells, so it should be chosen rather than
 * arrived at.
 */
const TIMEOUT_CHOICES: [seconds: number | null, label: string][] = [
  [5 * 60, '5 minutes'],
  [15 * 60, '15 minutes'],
  // Thirty, because the jump from fifteen minutes to an hour was the whole middle of the range.
  [30 * 60, '30 minutes'],
  [60 * 60, '1 hour'],
  [4 * 60 * 60, '4 hours'],
  [null, 'Keep forever'],
];

/** Megabytes, because that is what a person budgeting memory is actually budgeting. */
const SCROLLBACK_CHOICES: [bytes: number, label: string][] = [
  [1024 * 1024, '1 MB'],
  [2 * 1024 * 1024, '2 MB'],
  [5 * 1024 * 1024, '5 MB'],
  [10 * 1024 * 1024, '10 MB'],
  [25 * 1024 * 1024, '25 MB'],
  [50 * 1024 * 1024, '50 MB'],
];

/** Offered thresholds. A slider would imply a precision nobody wants from this. */
const THRESHOLDS: [ms: number, label: string][] = [
  [5_000, '5 seconds'],
  [15_000, '15 seconds'],
  [30_000, '30 seconds'],
  [60_000, '1 minute'],
  [300_000, '5 minutes'],
  [600_000, '10 minutes'],
];

// Derived from the table that defines them, so the list and the themes cannot disagree.
const THEMES = THEME_CHOICES;

/**
 * One section, with a heading that says what the settings under it are about.
 *
 * The panel used to be a single flat column of controls in five different type sizes, with each
 * description glued to the end of the label it belonged to. Nothing said which control went with
 * which explanation, so the whole thing read as a list of unrelated switches.
 */
function section(title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'set-section';
  const heading = document.createElement('h3');
  heading.className = 'set-heading';
  heading.textContent = title;
  el.append(heading);
  return el;
}

/**
 * A labelled control with its explanation on its own line, under the label and above the control.
 *
 * The order is deliberate: what it is, then what it means, then the thing you change. Reading it
 * top to bottom answers the question before offering the answer.
 */
function field(labelText: string, description: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'set-field';
  const label = document.createElement('span');
  label.className = 'set-label';
  label.textContent = labelText;
  const note = document.createElement('span');
  note.className = 'set-desc';
  note.textContent = description;
  row.append(label, note, control);
  return row;
}

/** A `select` built from a table, so the options and the values cannot drift apart. */
function chooser(
  choices: readonly (readonly [value: string, label: string])[],
  current: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const [value, label] of choices) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = current;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function buildSettings(options: SettingsOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cmd-settings';

  // --- Appearance ---------------------------------------------------------
  const look = section('Appearance');
  const themeSelect = chooser(THEMES, 'dark', (value) => options.onChangeTheme(value));
  void chrome.storage.local.get('tabterm.theme').then((stored) => {
    themeSelect.value = (stored['tabterm.theme'] as string | undefined) ?? 'dark';
  });
  look.append(field('Theme', 'Colors for the terminal and this panel', themeSelect));
  wrap.append(look);

  // --- Terminals ----------------------------------------------------------
  const terminals = section('Terminals');
  let hasTerminalSettings = false;

  const scrollback = options.scrollbackBytes();
  if (scrollback !== null) {
    hasTerminalSettings = true;
    terminals.append(
      field(
        'Scrollback kept per terminal',
        'How far back you can scroll. Kept on disk too, so it survives an update.',
        chooser(
          SCROLLBACK_CHOICES.map(([bytes, label]) => [String(bytes), label] as const),
          String(scrollback),
          (value) => options.onChangeScrollback(Number(value)),
        ),
      ),
    );
  }

  const timeout = options.backgroundTimeout();
  if (timeout !== undefined) {
    hasTerminalSettings = true;
    const choices = TIMEOUT_CHOICES.map(
      ([seconds, label]) => [seconds === null ? 'forever' : String(seconds), label] as const,
    );
    /**
     * A stored value that is not one of the offered choices still has to select something.
     *
     * Otherwise the select sits with no selection, and the next change event reads as an empty
     * string, which becomes 0, which the daemon reads as "keep forever". That is how choosing a
     * timeout could silently turn the timeout off, which is the opposite of what was clicked.
     */
    const wanted = timeout === null ? 'forever' : String(timeout);
    const offered = choices.some(([value]) => value === wanted)
      ? choices
      : [...choices, [wanted, `${String(Math.round((timeout ?? 0) / 60))} minutes`] as const];

    terminals.append(
      field(
        'Keep a terminal running after its tab closes',
        'Reopen the tab within this time and everything is still there. A terminal running a ' +
          'server, or still open in a tab, is never ended on a timer.',
        chooser(offered, wanted, (value) => {
          if (value === 'forever') {
            options.onChangeBackgroundTimeout(null);
            return;
          }
          const seconds = Number(value);
          // Never send a zero. Only an explicit "keep forever" should turn the timeout off.
          if (Number.isFinite(seconds) && seconds > 0) options.onChangeBackgroundTimeout(seconds);
        }),
      ),
    );
  }
  if (hasTerminalSettings) wrap.append(terminals);

  wrap.append(buildNotifications(options));

  wrap.append(buildDangerZone(options));

  // --- Shortcuts ----------------------------------------------------------
  const keys = section('Keyboard shortcuts');

  /**
   * The ones this page handles, which Chrome's settings screen can never show.
   *
   * Chrome only lets a person rebind what an extension declares as a command, and a command
   * fires in the worker rather than in a page, so anything acting on a pane has to be handled
   * here and therefore chosen here.
   */
  const mine = document.createElement('div');
  mine.className = 'set-keys';
  let saidActions = false;
  for (const shortcut of options.pageShortcuts()) {
    /**
     * A line before the ones bound to actions somebody made.
     *
     * They are bound the same way and stored in the same list, which is what keeps one key from
     * being claimed twice. But they answer a different question, so the list says where the
     * shipped ones end.
     */
    if (!saidActions && shortcut.id.startsWith('action:')) {
      saidActions = true;
      const heading = document.createElement('p');
      heading.className = 'set-desc';
      heading.textContent = 'Actions you made:';
      mine.append(heading);
    }
    const row = document.createElement('div');
    row.className = 'set-key-row';
    const label = document.createElement('span');
    label.className = 'set-label';
    label.textContent = shortcut.title;

    const button = document.createElement('button');
    button.className = 'cmd-button set-key';
    button.textContent = prettyKeys(shortcut.keys);

    const problem = document.createElement('span');
    problem.className = 'set-desc set-key-problem';

    /**
     * A way to have no shortcut at all.
     *
     * Recording one is the only thing this offered, so a key could be changed and never removed:
     * the way back was to bind it to something else and hope. Only shown when there is one to
     * clear, because a button that does nothing is worse than no button.
     */
    const clear = document.createElement('button');
    clear.className = 'cmd-button set-key-clear';
    clear.textContent = 'Clear';
    clear.title = 'Leave this with no shortcut';
    clear.hidden = shortcut.keys === '';
    clear.addEventListener('click', () => {
      options.onRebind(shortcut.id, '');
      button.textContent = prettyKeys('');
      problem.textContent = '';
      clear.hidden = true;
    });

    button.addEventListener('click', () => {
      if (button.dataset['recording'] === 'yes') return;
      button.dataset['recording'] = 'yes';
      button.textContent = 'Press the keys, or Escape to leave it';
      problem.textContent = '';

      const onKey = (e: KeyboardEvent): void => {
        /**
         * Stopped here, and stopped **hard**, while a key is being recorded.
         *
         * Escape closes the settings panel, which is right everywhere except in the middle of
         * this: pressing it to say "leave the shortcut alone" closed the whole menu. The listener
         * runs at the capture phase, so stopping propagation immediately is what keeps the panel
         * out of it. `stopImmediatePropagation` rather than `stopPropagation` because another
         * listener on this same element would otherwise still see it.
         */
        e.preventDefault();
        e.stopImmediatePropagation();
        // A modifier on its own is somebody still reaching for the rest of the combination.
        if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return;
        document.removeEventListener('keydown', onKey, true);
        delete button.dataset['recording'];

        if (e.key === 'Escape') {
          button.textContent = prettyKeys(shortcut.keys);
          return;
        }
        /**
         * Backspace clears it, which is what every settings screen that binds keys does.
         *
         * The button beside it does the same thing for somebody who does not know that.
         */
        if (e.key === 'Backspace' || e.key === 'Delete') {
          options.onRebind(shortcut.id, '');
          button.textContent = prettyKeys('');
          clear.hidden = true;
          return;
        }
        const keys = describeKeys(e);
        const refused = options.onRebind(shortcut.id, keys);
        if (refused === null) {
          button.textContent = prettyKeys(keys);
          problem.textContent = '';
          clear.hidden = false;
          return;
        }
        button.textContent = prettyKeys(shortcut.keys);
        problem.textContent = refused;
      };
      document.addEventListener('keydown', onKey, true);
    });

    row.append(label, button, clear, problem);
    mine.append(row);
  }
  keys.append(mine);

  /**
   * What not to bind, said before somebody spends a minute finding out.
   *
   * The refusal that comes back names the combination that was pressed, which is the right
   * moment for a specific message and the wrong moment for a general one.
   */
  const caution = document.createElement('p');
  caution.className = 'set-desc';
  caution.textContent =
    'Chrome keeps combinations like Command W, Command T and Command L for itself, and other ' +
    'extensions can claim their own. A key Chrome has taken never reaches this page, so it is ' +
    'refused here rather than bound to something that will not work.';
  keys.append(caution);
  // The keys that cannot be changed are not settings and were only ever a list to read past.
  const chromeNote = document.createElement('p');
  chromeNote.className = 'set-desc';
  chromeNote.textContent =
    'The shortcut that opens a terminal belongs to Chrome, so it can only be changed there.';
  const openShortcuts = document.createElement('button');
  openShortcuts.className = 'cmd-button';
  openShortcuts.textContent = 'Change it in Chrome';
  openShortcuts.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
  });
  keys.append(chromeNote, openShortcuts);
  wrap.append(keys);

  return wrap;
}

/**
 * The things that put something back, and the one that takes everything away.
 *
 * Last, because nothing here is part of using the product, and each destructive one asks first.
 * A button that acts on its first press is the wrong shape for an answer you cannot take back.
 */
function buildDangerZone(options: SettingsOptions): HTMLElement {
  const wrap = section('Starting over');

  const altered = options.alteredTemplates();
  if (altered > 0) {
    /**
     * Offered only when there is something to put back.
     *
     * A permanent button for something you have not done is one more line to read past every
     * time this page is opened, and it would say the same thing whether it applied or not.
     */
    const row = document.createElement('div');
    row.className = 'set-field';
    const label = document.createElement('span');
    label.className = 'set-label';
    label.textContent = 'Restore the templates that ship with TabTerm';
    const note = document.createElement('span');
    note.className = 'set-desc';
    note.textContent =
      altered === 1
        ? 'One of them has been deleted or changed. Restoring adds back only what is missing, ' +
          'in its original place, and leaves everything else alone.'
        : `${String(altered)} of them have been deleted or changed. Restoring adds back only ` +
          'what is missing, in its original place, and leaves everything else alone.';
    const button = document.createElement('button');
    button.className = 'cmd-button';
    button.textContent = 'Restore default templates';
    button.addEventListener('click', () => options.onRestoreTemplates());
    row.append(label, note, button);
    wrap.append(row);
  }

  wrap.append(
    confirming({
      label: 'Restore all settings',
      description:
        'Every switch and every choice on this page goes back to how it shipped. Your ' +
        'terminals, history and templates are not touched.',
      confirm: 'Yes, restore all settings',
      onConfirm: options.onRestoreSettings,
    }),
    confirming({
      label: 'Erase everything TabTerm has stored',
      description:
        'Ends every terminal, and deletes history, saved commands, templates, highlights and ' +
        'every preference. TabTerm itself stays installed and starts as if it were new. There ' +
        'is no undo.',
      confirm: 'Yes, erase everything',
      onConfirm: options.onEraseEverything,
      grave: true,
    }),
  );

  return wrap;
}

/**
 * A button that asks before it acts, in place, without a dialog.
 *
 * The first press turns it into the question and a second button; anything else puts it back.
 * A modal over a page of switches would be a second thing to read before answering a question
 * the row already asked.
 */
function confirming(opts: {
  label: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  grave?: boolean;
}): HTMLElement {
  const row = document.createElement('div');
  row.className = 'set-field';
  const label = document.createElement('span');
  label.className = 'set-label';
  label.textContent = opts.label;
  const note = document.createElement('span');
  note.className = 'set-desc';
  note.textContent = opts.description;

  const buttons = document.createElement('div');
  buttons.className = 'set-danger-row';
  const ask = document.createElement('button');
  ask.className = opts.grave ? 'cmd-button is-grave' : 'cmd-button is-warning';
  ask.textContent = opts.label;
  buttons.append(ask);

  ask.addEventListener('click', () => {
    if (buttons.dataset['asking'] === 'yes') return;
    buttons.dataset['asking'] = 'yes';
    ask.hidden = true;

    const yes = document.createElement('button');
    yes.className = opts.grave ? 'cmd-button is-grave' : 'cmd-button is-warning';
    yes.textContent = opts.confirm;
    const no = document.createElement('button');
    no.className = 'cmd-button';
    no.textContent = 'Cancel';

    const done = (): void => {
      yes.remove();
      no.remove();
      ask.hidden = false;
      delete buttons.dataset['asking'];
    };
    yes.addEventListener('click', () => {
      done();
      opts.onConfirm();
    });
    no.addEventListener('click', done);
    buttons.append(yes, no);
  });

  row.append(label, note, buttons);
  return row;
}

function toggle(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'set-toggle';
  const text = document.createElement('span');
  text.className = 'set-toggle-text';
  const name = document.createElement('span');
  name.className = 'set-label';
  name.textContent = label;
  text.append(name);
  if (hint !== undefined) {
    // A sibling, not a child of the label. Appending it inside meant the two ran together as
    // one sentence: "History kept per terminalApplies everywhere it is stored".
    const note = document.createElement('span');
    note.className = 'set-desc';
    note.textContent = hint;
    text.append(note);
  }
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  row.append(text, box);
  return row;
}

/**
 * Notifications, and the hooks that make half of them possible.
 *
 * The agent switch sits here rather than in an install script because that is where it was and
 * essentially nobody ran it, which left agent status doing nothing with no way to tell that
 * apart from an agent that never needed anything. See docs/09-agent-integration.md.
 */
function buildNotifications(options: SettingsOptions): HTMLElement {
  const wrap = section('Notifications');

  const policy = options.notify();
  if (!policy) {
    const pending = document.createElement('p');
    pending.className = 'set-desc';
    pending.textContent = 'Waiting for the daemon.';
    wrap.append(pending);
    return wrap;
  }

  wrap.append(
    toggle(
      'Tell me when something finishes',
      policy.enabled,
      (enabled) => options.onChangeNotify({ enabled }),
      'A desktop notification naming the command that ended',
    ),
  );

  /**
   * The threshold, only while notifications are on.
   *
   * A picker for how long a notification you are not receiving has to have taken is not a
   * setting, it is a puzzle. It is indented under the switch that governs it, so it reads as
   * belonging to that switch rather than as the next unrelated thing in the list.
   */
  if (policy.enabled) {
    const threshold = field(
      'Only for commands that took longer than',
      'Short commands finish before you have looked away, so telling you about them is noise.',
      chooser(
        THRESHOLDS.map(([ms, label]) => [String(ms), label] as const),
        String(policy.thresholdMs),
        (value) => options.onChangeNotify({ thresholdMs: Number(value) }),
      ),
    );
    threshold.classList.add('set-nested');
    wrap.append(threshold);

    wrap.append(
      nested(
        toggle('For shell commands', policy.commands, (commands) =>
          options.onChangeNotify({ commands }),
        ),
      ),
      nested(
        toggle('For agent turns', policy.agentTurns, (agentTurns) =>
          options.onChangeNotify({ agentTurns }),
        ),
      ),
      nested(
        toggle(
          'Not for a pane I am already looking at',
          policy.onlyWhenUnfocused,
          (onlyWhenUnfocused) => options.onChangeNotify({ onlyWhenUnfocused }),
        ),
      ),
    );
  }

  /**
   * What launching an agent runs.
   *
   * A box rather than a list of the agents we know about, because the browser-wide shortcut for
   * this is a key somebody binds once and presses for a year, and until now it ran whatever was
   * compiled in. The daemon splits it into argv and never hands it to a shell.
   *
   * Saved on blur and on Return rather than on every keystroke: half a command is not a command,
   * and a setting that changes while it is being typed is one that is briefly wrong.
   */
  const agentCommand = options.agentCommand();
  if (agentCommand !== null) {
    const box = document.createElement('input');
    box.className = 'launcher-input set-input';
    box.spellcheck = false;
    box.value = agentCommand;
    box.placeholder = 'claude';
    const commit = (): void => {
      const typed = box.value.trim();
      if (typed === agentCommand) return;
      options.onChangeAgentCommand(typed);
    };
    box.addEventListener('blur', commit);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        box.blur();
      }
      // Not the terminal's, while somebody is typing in a box.
      e.stopPropagation();
    });
    wrap.append(
      field(
        'What launching an agent runs',
        'Used by the command menu and by the browser shortcut. Arguments are allowed, and quotes ' +
          'for a path with a space in it. Leave it empty for claude.',
        box,
      ),
    );
  }

  const hooks = options.agentHooks();
  if (hooks) {
    wrap.append(
      toggle(
        'Let agents report what they are doing',
        hooks.installed,
        options.onChangeAgentHooks,
        describeHooks(hooks),
      ),
    );
  }

  const shell = options.shellIntegration();
  if (shell) {
    wrap.append(
      toggle(
        'Tell finished from failed',
        shell.installed || shell.sourcedElsewhere,
        options.onChangeShellIntegration,
        describeShell(shell),
      ),
    );
  }

  return wrap;
}

/** Indented, so it reads as belonging to the switch above it rather than standing on its own. */
function nested(el: HTMLElement): HTMLElement {
  el.classList.add('set-nested');
  return el;
}

/**
 * What the agent hooks are actually doing.
 *
 * "Installed" and "working" are different claims, so both are said. Hooks that are present and
 * have never fired is a real state and the one worth being able to see.
 */
export function describeHooks(hooks: AgentHooksStatus): string {
  const supported = hooks.targets.filter((t) => t.supported && t.detected);
  const others = hooks.targets.filter((t) => !t.supported && t.detected);
  const trailing =
    others.length > 0 ? `. ${others.map((t) => t.name).join(', ')} not supported yet` : '';

  /**
   * Nothing found says how to get one, rather than only that there is nothing.
   *
   * This panel is read by somebody who has just installed TabTerm and has no agent CLI at all.
   * "No supported agent CLI found" is true and leaves them nowhere, and the previous version was
   * worse than that: it claimed hooks were installed for Claude Code on the strength of a
   * directory in the home folder, which survives uninstalling the tool.
   */
  if (supported.length === 0) {
    const how = hooks.targets
      .filter((t) => t.supported && t.install)
      .map((t) => `${t.name}: ${String(t.install)}`)
      .join(', ');
    return how === ''
      ? `No supported agent CLI found${trailing}`
      : `No agent CLI found. Install one and this turns itself on: ${how}${trailing}`;
  }
  if (!hooks.installed) return `Agent status and agent turn notifications need this${trailing}`;
  const names = supported.map((t) => t.name).join(', ');
  /**
   * Named where it is, because "installed" is a claim about two different places.
   *
   * The hook script is TabTerm's, in its own directory. The entry that calls it is written into
   * the agent's own settings file, which is the agent's, and that is the half worth pointing at
   * when somebody asks where this lives or wants to remove it by hand.
   */
  const where = supported
    .map((t) => shortHome(t.settingsPath))
    .filter((p) => p !== '')
    .join(', ');
  const seen =
    hooks.lastEventAt === undefined ? 'no events yet' : `last event ${ago(hooks.lastEventAt)}`;
  return `Installed for ${names} in ${where}, ${seen}${trailing}`;
}

/** A path written the way a shell writes it, since a settings line is read, not clicked. */
function shortHome(path: string): string {
  const match = /^\/Users\/[^/]+\//.exec(path);
  return match ? `~/${path.slice(match[0].length)}` : path;
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * What the shell integration is worth, said in terms of what changes without it.
 *
 * "Emits OSC 133" is true and tells nobody anything. Exit codes are the visible consequence:
 * without them a tab can say a command ended but never that it failed.
 */
function describeShell(shell: ShellIntegrationStatus): string {
  if (shell.sourcedElsewhere) return 'Already sourced from your shell profile';
  if (!shell.scriptStaged) return 'Run the installer first';
  return shell.installed
    ? 'Adds exit codes, so finished can be told from failed. Open a new tab to apply'
    : 'Without it there are no exit codes, so nothing can say a command failed';
}
