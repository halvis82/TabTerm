import { THEME_CHOICES } from '../terminal/themes.js';
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
  shellIntegration: () => ShellIntegrationStatus | null;
  onChangeShellIntegration: (enabled: boolean) => void;
  /** Bytes of output kept per session, across every copy of it. Null until the daemon answers. */
  scrollbackBytes: () => number | null;
  onChangeScrollback: (bytes: number) => void;
  /** Seconds a session with no tab is kept, null for forever, undefined until the daemon says. */
  backgroundTimeout: () => number | null | undefined;
  onChangeBackgroundTimeout: (seconds: number | null) => void;
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

/** Shortcuts the page handles itself, as opposed to the ones Chrome owns. */
const PAGE_KEYS: [keys: string, does: string][] = [
  ['⌘K', 'Open this panel'],
  ['⇧⌘P', 'Open the command palette'],
  ['⌘D', 'Split right'],
  ['⇧⌘D', 'Split down'],
  ['⌘W', 'Close pane (in focus mode)'],
  ['⇧⌘A', 'Launch an agent'],
  ['⇧⌘K', 'Clear the screen'],
  ['⌘C / ⌘V', 'Copy and paste'],
  ['Esc', 'Restore a maximized pane'],
];

export function buildSettings(options: SettingsOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cmd-settings';

  const theme = document.createElement('label');
  theme.className = 'cmd-field';
  const themeLabel = document.createElement('span');
  themeLabel.textContent = 'Theme';
  const select = document.createElement('select');
  for (const [value, label] of THEMES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  void chrome.storage.local.get('tabterm.theme').then((stored) => {
    select.value = (stored['tabterm.theme'] as string | undefined) ?? 'dark';
  });
  select.addEventListener('change', () => options.onChangeTheme(select.value));
  theme.append(themeLabel, select);
  wrap.append(theme);

  const scrollback = options.scrollbackBytes();
  if (scrollback !== null) {
    const field = document.createElement('label');
    field.className = 'cmd-field';
    const label = document.createElement('span');
    label.textContent = 'History kept per terminal';
    const note = document.createElement('small');
    note.textContent = 'Applies everywhere it is stored, including what survives an update';
    label.append(note);
    const select = document.createElement('select');
    for (const [bytes, text] of SCROLLBACK_CHOICES) {
      const option = document.createElement('option');
      option.value = String(bytes);
      option.textContent = text;
      select.append(option);
    }
    select.value = String(scrollback);
    select.addEventListener('change', () => options.onChangeScrollback(Number(select.value)));
    field.append(label, select);
    wrap.append(field);
  }

  const timeout = options.backgroundTimeout();
  if (timeout !== undefined) {
    const field = document.createElement('label');
    field.className = 'cmd-field';
    const label = document.createElement('span');
    label.textContent = 'Keep a terminal with no tab for';
    const note = document.createElement('small');
    note.textContent = 'Anything running a server, or open in a tab, is never ended on a timer';
    label.append(note);
    const select = document.createElement('select');
    for (const [seconds, text] of TIMEOUT_CHOICES) {
      const option = document.createElement('option');
      option.value = seconds === null ? 'forever' : String(seconds);
      option.textContent = text;
      select.append(option);
    }
    /**
     * A stored value that is not one of the offered choices still has to select something.
     *
     * Otherwise the select sits with no selection, and the next change event reads as an empty
     * string, which becomes 0, which the daemon reads as "keep forever". That is how choosing a
     * timeout could silently turn the timeout off, which is the opposite of what was clicked.
     */
    const wanted = timeout === null ? 'forever' : String(timeout);
    if (
      !TIMEOUT_CHOICES.some(
        ([seconds]) => (seconds === null ? 'forever' : String(seconds)) === wanted,
      )
    ) {
      const custom = document.createElement('option');
      custom.value = wanted;
      custom.textContent = `${String(Math.round((timeout ?? 0) / 60))} minutes`;
      select.append(custom);
    }
    select.value = wanted;
    select.addEventListener('change', () => {
      if (select.value === 'forever') {
        options.onChangeBackgroundTimeout(null);
        return;
      }
      const seconds = Number(select.value);
      // Never send a zero. Only an explicit "keep forever" should turn the timeout off.
      if (Number.isFinite(seconds) && seconds > 0) options.onChangeBackgroundTimeout(seconds);
    });
    field.append(label, select);
    wrap.append(field);
  }

  wrap.append(buildNotifications(options));

  const keysHeading = document.createElement('div');
  keysHeading.className = 'cmd-note';
  keysHeading.textContent = 'Shortcuts inside a terminal tab';
  wrap.append(keysHeading);

  const list = document.createElement('div');
  list.className = 'cmd-keys';
  for (const [keys, does] of PAGE_KEYS) {
    const row = document.createElement('div');
    row.className = 'cmd-key-row';
    const combo = document.createElement('kbd');
    combo.textContent = keys;
    const description = document.createElement('span');
    description.textContent = does;
    row.append(combo, description);
    list.append(row);
  }
  wrap.append(list);

  const chromeNote = document.createElement('div');
  chromeNote.className = 'cmd-note';
  chromeNote.textContent =
    'The shortcut that opens a terminal belongs to Chrome, not to TabTerm, so it can only be ' +
    'changed there.';
  wrap.append(chromeNote);

  const openShortcuts = document.createElement('button');
  openShortcuts.className = 'cmd-button';
  openShortcuts.textContent = 'Chrome shortcuts';
  openShortcuts.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
  });
  wrap.append(openShortcuts);

  return wrap;
}

function toggle(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'cmd-field cmd-toggle';
  const text = document.createElement('span');
  text.textContent = label;
  if (hint !== undefined) {
    const note = document.createElement('small');
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
  const section = document.createElement('div');
  section.className = 'cmd-section';

  const heading = document.createElement('div');
  heading.className = 'cmd-note';
  heading.textContent = 'Tell me when something finishes';
  section.append(heading);

  const policy = options.notify();
  if (!policy) {
    const pending = document.createElement('div');
    pending.className = 'cmd-note cmd-dim';
    pending.textContent = 'Waiting for the daemon.';
    section.append(pending);
    return section;
  }

  section.append(
    toggle('Desktop notifications', policy.enabled, (enabled) =>
      options.onChangeNotify({ enabled }),
    ),
  );

  const threshold = document.createElement('label');
  threshold.className = 'cmd-field';
  const thresholdLabel = document.createElement('span');
  thresholdLabel.textContent = 'Only if it took longer than';
  const select = document.createElement('select');
  for (const [ms, label] of THRESHOLDS) {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = label;
    select.append(option);
  }
  select.value = String(policy.thresholdMs);
  select.addEventListener('change', () =>
    options.onChangeNotify({ thresholdMs: Number(select.value) }),
  );
  threshold.append(thresholdLabel, select);
  section.append(threshold);

  section.append(
    toggle('Shell commands', policy.commands, (commands) => options.onChangeNotify({ commands })),
    toggle('Agent turns', policy.agentTurns, (agentTurns) =>
      options.onChangeNotify({ agentTurns }),
    ),
    toggle(
      'Stay quiet while I am looking',
      policy.onlyWhenUnfocused,
      (onlyWhenUnfocused) => options.onChangeNotify({ onlyWhenUnfocused }),
      'Nothing for a pane already on screen',
    ),
  );

  const hooks = options.agentHooks();
  if (hooks) {
    section.append(
      toggle('Agent events', hooks.installed, options.onChangeAgentHooks, describeHooks(hooks)),
    );
  }

  const shell = options.shellIntegration();
  if (shell) {
    section.append(
      toggle(
        'Shell integration',
        shell.installed || shell.sourcedElsewhere,
        options.onChangeShellIntegration,
        describeShell(shell),
      ),
    );
  }

  return section;
}

/**
 * What the agent hooks are actually doing.
 *
 * "Installed" and "working" are different claims, so both are said. Hooks that are present and
 * have never fired is a real state and the one worth being able to see.
 */
function describeHooks(hooks: AgentHooksStatus): string {
  const supported = hooks.targets.filter((t) => t.supported && t.detected);
  const others = hooks.targets.filter((t) => !t.supported && t.detected);
  const trailing =
    others.length > 0 ? `. ${others.map((t) => t.name).join(', ')} not supported yet` : '';

  if (supported.length === 0) return `No supported agent CLI found${trailing}`;
  if (!hooks.installed) return `Agent status and agent turn notifications need this${trailing}`;
  const names = supported.map((t) => t.name).join(', ');
  return hooks.lastEventAt === undefined
    ? `Installed for ${names}. No events yet${trailing}`
    : `Installed for ${names}. Last event ${ago(hooks.lastEventAt)}${trailing}`;
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
