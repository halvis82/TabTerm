import {
  COPY_LINES_CHOICES,
  COPY_LINES_KEY,
  DEFAULT_COPY_LINES,
  saneCopyLines,
} from '../terminal/command-output.js';
import { BELL_KEY, PROGRAM_COPY_KEY } from '../terminal/osc52.js';
import { VERSION, type CompanionUpdateStatus, type Concern } from '@tabterm/shared';
import { THEME_CHOICES } from '../terminal/themes.js';
import {
  DEFAULT_LABEL_OPACITY,
  DEFAULT_LABEL_SCALE,
  LABEL_OPACITY_KEY,
  LABEL_SCALE_KEY,
  obscuresOutput,
  saneOpacity,
  saneScale,
} from '../terminal/label-look.js';
import { describeKeys, prettyKeys } from '../terminal/page-shortcuts.js';
import type {
  AgentHooksStatus,
  NotifyPolicy,
  RemoteAccessState,
  ShellIntegrationStatus,
} from '@tabterm/shared';
import qrcode from 'qrcode-generator';
/**
 * Settings, reached from the gear in the panel's footer.
 *
 * Only what TabTerm actually controls. Chrome owns the shortcut that opens a terminal when no
 * terminal has focus -- an extension cannot rebind that, and only `chrome://extensions/shortcuts`
 * can, so this links there and says why rather than offering a control that would not work.
 * Everything that happens *inside* a tab is ours and is listed here.
 */

export interface SettingsOptions {
  /** What the daemon's live checks found, or nothing. */
  attention?: () => readonly Concern[];
  onRecheckAttention?: () => void;
  updates?: () => CompanionUpdateStatus | null;
  companionVersion?: () => string;
  onCheckUpdate?: () => void;
  onInstallUpdate?: () => void;
  onUpdatePreferences?: (checks: boolean, install: boolean) => void;
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
  /** Remote access, or null until the daemon has answered. */
  remote?: () => RemoteAccessState | null;
  /** A pairing link just made, for the code on screen, or null. */
  remotePairing?: () => { link: string; expiresAt: number } | null;
  onRemoteSet?: (change: { enabled?: boolean; relayUrl?: string; relaySecret?: string }) => void;
  onRemotePair?: () => void;
  onRemoteDevice?: (change: {
    deviceId: string;
    typing?: boolean;
    name?: string;
    forget?: boolean;
  }) => void;
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

/**
 * Offered strengths for the name drawn over a pane, with the default named.
 *
 * Steps rather than a slider, for the same reason as every other setting here: a slider implies a
 * precision nobody wants, and the difference between 0.16 and 0.17 is not a decision.
 */
const LABEL_OPACITY_CHOICES: readonly (readonly [string, string])[] = [
  ['0', 'Off'],
  ['0.08', 'Faintest'],
  ['0.16', 'Faint (default)'],
  ['0.3', 'Clear'],
  ['0.45', 'Strong'],
  ['0.95', 'Strongest'],
];

/** And sizes, as a multiple of the size it works out from the pane. */
const LABEL_SCALE_CHOICES: readonly (readonly [string, string])[] = [
  ['0.6', 'Small'],
  ['0.8', 'Smaller'],
  ['1', 'Normal (default)'],
  ['1.3', 'Larger'],
  ['1.6', 'Large'],
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
  /*
   * A choice from a list sits beside what it is about, as a switch does, so a page of them is a
   * page of rows rather than a column of label, sentence, box, label, sentence, box. A box to type
   * in stays underneath, where it has the width to show what is typed.
   */
  if (control instanceof HTMLSelectElement) {
    row.classList.add('set-field-inline');
    const text = document.createElement('span');
    text.className = 'set-toggle-text';
    text.append(label, note);
    row.append(text, control);
    return row;
  }
  row.append(label, note, control);
  return row;
}

/**
 * The pages of Settings, in the order they are offered. Settings grew to some thirty controls in
 * one column, which was hard to find anything in, so they are grouped by what they are about and
 * shown a page at a time, with a search across all of them.
 */
const PAGES = [
  ['appearance', 'Theme'],
  ['terminals', 'Terminals'],
  ['agents', 'Agents'],
  ['notifications', 'Alerts'],
  ['remote', 'Remote'],
  ['shortcuts', 'Keys'],
  ['about', 'About'],
] as const;
type Page = (typeof PAGES)[number][0];
const PAGE_KEY = 'tabterm.settingsPage';

/** The page last looked at, kept across the redraws Settings has whenever the daemon reports. */
let currentPage: Page = (() => {
  try {
    const stored = localStorage.getItem(PAGE_KEY);
    return PAGES.some(([id]) => id === stored) ? (stored as Page) : 'appearance';
  } catch {
    return 'appearance';
  }
})();
/** What is typed in the search, kept across redraws for the same reason. */
let searching = '';

/**
 * The tabs, the search, and the pages under them. Every page is built, and the ones not shown are
 * hidden, so the search can look through all of them and a page switch is instant.
 */
function paged(pages: Map<Page, HTMLElement[]>): HTMLElement[] {
  const nav = document.createElement('div');
  nav.className = 'set-nav';
  nav.setAttribute('role', 'tablist');
  const search = document.createElement('input');
  search.className = 'launcher-input set-search';
  search.type = 'search';
  search.placeholder = 'Search settings';
  search.spellcheck = false;
  search.setAttribute('aria-label', 'Search settings');
  search.value = searching;
  const holders = new Map<Page, HTMLElement>();
  const buttons = new Map<Page, HTMLButtonElement>();
  const empty = document.createElement('p');
  empty.className = 'set-desc set-search-empty';
  empty.textContent = 'No setting matches that.';

  const draw = (): void => {
    const query = searching.trim().toLowerCase();
    for (const [id, holder] of holders) {
      holder.hidden = query === '' && id !== currentPage;
      // Headings name the group a match is in; on a page of one group the tab already does.
      holder.classList.toggle('searching', query !== '');
      buttons.get(id)?.classList.toggle('on', query === '' && id === currentPage);
      buttons.get(id)?.setAttribute('aria-selected', String(query === '' && id === currentPage));
    }
    let any = false;
    for (const holder of holders.values()) {
      for (const sectionEl of holder.querySelectorAll<HTMLElement>('.set-section')) {
        let shown = 0;
        for (const row of sectionEl.children) {
          if (!(row instanceof HTMLElement) || row.classList.contains('set-heading')) continue;
          const match = query === '' || (row.textContent ?? '').toLowerCase().includes(query);
          row.classList.toggle('set-filtered', !match);
          if (match) shown++;
        }
        const headingMatch =
          query !== '' &&
          (sectionEl.querySelector('.set-heading')?.textContent ?? '')
            .toLowerCase()
            .includes(query);
        if (headingMatch) {
          for (const row of sectionEl.children) row.classList.remove('set-filtered');
          shown = 1;
        }
        sectionEl.hidden = query !== '' && shown === 0;
        if (shown > 0) any = true;
      }
    }
    empty.hidden = query === '' || any;
  };

  for (const [id, title] of PAGES) {
    const sections = pages.get(id) ?? [];
    if (sections.length === 0) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'set-nav-tab';
    button.textContent = title;
    button.dataset['settingsPage'] = id;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => {
      currentPage = id;
      searching = '';
      search.value = '';
      try {
        localStorage.setItem(PAGE_KEY, id);
      } catch {
        // Not remembered, which is fine.
      }
      draw();
      holders.get(id)?.closest('.cmd-body')?.scrollTo({ top: 0 });
    });
    nav.append(button);
    buttons.set(id, button);
    const holder = document.createElement('div');
    holder.className = 'set-page';
    holder.dataset['settingsPageBody'] = id;
    holder.setAttribute('role', 'tabpanel');
    holder.append(...sections);
    holders.set(id, holder);
  }
  // The page asked for may have nothing on it right now, such as Remote before the daemon answers.
  if (!holders.has(currentPage)) currentPage = holders.keys().next().value ?? 'appearance';
  search.addEventListener('input', () => {
    searching = search.value;
    draw();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value !== '') {
      e.stopPropagation();
      searching = '';
      search.value = '';
      draw();
    }
    // Not the terminal's, while somebody is typing in a box.
    if (e.key !== 'Escape') e.stopPropagation();
  });
  const top = document.createElement('div');
  top.className = 'set-top';
  top.append(search, nav);
  draw();
  return [top, empty, ...holders.values()];
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

  // First, when there is anything in it: a thing that is making terminals worse right now
  // outranks every preference below it.
  const attention = buildAttention(options);
  if (attention) wrap.append(attention);
  const pages = new Map<Page, HTMLElement[]>();
  const put = (page: Page, el: HTMLElement | null): void => {
    if (el) pages.set(page, [...(pages.get(page) ?? []), el]);
  };

  const look = section('Appearance');
  const themeSelect = chooser(THEMES, 'dark', (value) => options.onChangeTheme(value));
  void chrome.storage.local.get('tabterm.theme').then((stored) => {
    themeSelect.value = (stored['tabterm.theme'] as string | undefined) ?? 'dark';
  });
  look.append(field('Color theme', 'The colors of every terminal and of this menu.', themeSelect));

  /*
   * How the name drawn over a pane looks.
   *
   * It is deliberately faint, because it says which session this is without competing with what
   * the session is saying, and how faint is a judgement about a screen and a pair of eyes rather
   * than something one number settles. The defaults are named in the choices so it is obvious
   * which one is the way it came.
   */
  const opacitySelect = chooser(LABEL_OPACITY_CHOICES, String(DEFAULT_LABEL_OPACITY), (value) => {
    void chrome.storage.local.set({ [LABEL_OPACITY_KEY]: Number(value) });
    opacityWarning.hidden = !obscuresOutput(Number(value));
  });
  const opacityWarning = document.createElement('div');
  opacityWarning.className = 'cmd-settings-warning';
  opacityWarning.textContent = 'At this strength the name hides the output behind it.';
  opacityWarning.hidden = true;

  const scaleSelect = chooser(LABEL_SCALE_CHOICES, String(DEFAULT_LABEL_SCALE), (value) => {
    void chrome.storage.local.set({ [LABEL_SCALE_KEY]: Number(value) });
  });

  void chrome.storage.local.get([LABEL_OPACITY_KEY, LABEL_SCALE_KEY]).then((stored) => {
    const opacity = saneOpacity(stored[LABEL_OPACITY_KEY] ?? DEFAULT_LABEL_OPACITY);
    opacitySelect.value = String(opacity);
    opacityWarning.hidden = !obscuresOutput(opacity);
    scaleSelect.value = String(saneScale(stored[LABEL_SCALE_KEY] ?? DEFAULT_LABEL_SCALE));
  });

  look.append(
    field(
      'Session name visibility',
      'A session you named shows its name written large and faint behind its text. How strongly it shows.',
      opacitySelect,
    ),
  );
  look.append(opacityWarning);
  look.append(
    field('Session name size', 'How large that name is written behind the text.', scaleSelect),
  );
  put('appearance', look);

  // --- Terminals ----------------------------------------------------------
  const terminals = section('Terminals');
  let hasTerminalSettings = false;

  const scrollback = options.scrollbackBytes();
  if (scrollback !== null) {
    hasTerminalSettings = true;
    terminals.append(
      field(
        'History kept per terminal',
        'How much output each terminal keeps to scroll back through. Kept on disk too, so it survives an update.',
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
  /*
   * How much one Copy output takes, beside the scrollback because that is what it is a share of.
   *
   * A choice of steps up to a ceiling rather than a number to type, so no value can put more on
   * the clipboard than a page can hand over comfortably. Past it, the newest lines are copied and
   * the button says how many.
   */
  hasTerminalSettings = true;
  const copySelect = chooser(COPY_LINES_CHOICES, String(DEFAULT_COPY_LINES), (value) => {
    void chrome.storage.local.set({ [COPY_LINES_KEY]: saneCopyLines(value) });
  });
  void chrome.storage.local.get(COPY_LINES_KEY).then((stored) => {
    copySelect.value = String(saneCopyLines(stored[COPY_LINES_KEY] ?? DEFAULT_COPY_LINES));
  });
  terminals.append(
    field(
      'Copy output copies at most',
      'Pointing at a finished command shows Copy output, which copies what that command printed. Longer output copies its last lines.',
      copySelect,
    ),
  );
  /*
   * What programs may do beyond drawing. Both on by default, as in other terminals, and both a
   * switch because a copy made for you and a flash you did not ask for are each somebody's taste.
   */
  const programCopy = toggle(
    'Let programs copy to your clipboard',
    true,
    (on) => void chrome.storage.local.set({ [PROGRAM_COPY_KEY]: on }),
    'Programs such as vim and tmux, also over ssh, can put text on your clipboard (OSC 52). They can never read it.',
  );
  const bell = toggle(
    'Flash when a program rings the bell',
    true,
    (on) => void chrome.storage.local.set({ [BELL_KEY]: on }),
    'The terminal bell is the beep a program makes, for example when Tab finds nothing to complete. TabTerm shows it as a brief flash on the pane, and on the icon of a tab in the background. It makes no sound.',
  );
  void chrome.storage.local.get([PROGRAM_COPY_KEY, BELL_KEY]).then((stored) => {
    const copyBox = programCopy.querySelector('input');
    const bellBox = bell.querySelector('input');
    if (copyBox) copyBox.checked = stored[PROGRAM_COPY_KEY] !== false;
    if (bellBox) bellBox.checked = stored[BELL_KEY] !== false;
  });
  terminals.append(programCopy, bell);
  const shell = options.shellIntegration();
  if (shell) {
    terminals.append(
      toggle(
        'Show whether each command succeeded or failed',
        shell.installed || shell.sourcedElsewhere,
        options.onChangeShellIntegration,
        describeShell(shell),
      ),
    );
  }
  if (hasTerminalSettings) put('terminals', terminals);

  put('agents', buildAgents(options));
  put('notifications', buildNotifications(options));
  put('remote', buildRemote(options));

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
         * this: pressing it to say "leave the shortcut alone" took the settings page away with
         * it, and the row being bound with that.
         *
         * On `window` rather than `document`, which is the part that makes stopping work.
         * Capture runs from the top of the path down, and the page's own Escape handler is a
         * capture listener on `document` registered when the page was built, so on the same
         * target it would run first however hard this one stopped the event. `window` is one
         * step above `document` and is reached before it.
         */
        e.preventDefault();
        e.stopImmediatePropagation();
        // A modifier on its own is somebody still reaching for the rest of the combination.
        if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return;
        window.removeEventListener('keydown', onKey, true);
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
      window.addEventListener('keydown', onKey, true);
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
  put('shortcuts', keys);
  // Last, by request: nothing here is part of using a terminal, and it changes least often.
  put('about', buildUpdates(options));
  put('about', buildDangerZone(options));

  wrap.append(...paged(pages));
  return wrap;
}

/**
 * What the daemon's live checks found, with the fix for each, or nothing at all.
 *
 * The doctor script says all of this and nobody runs the doctor on the afternoon a terminal
 * starts asking for permission on every launch. Asked for as: check for it live and say so in
 * Settings. The section exists only while there is something in it, so a healthy install never
 * sees a heading about problems.
 */
function buildAttention(options: SettingsOptions): HTMLElement | null {
  const concerns = options.attention?.() ?? [];
  if (concerns.length === 0) return null;
  const wrap = section('Needs attention');
  wrap.dataset['attention'] = 'true';
  for (const concern of concerns) {
    const row = document.createElement('div');
    row.className = `set-concern is-${concern.level}`;
    row.dataset['concern'] = concern.id;
    const title = document.createElement('div');
    title.className = 'set-label';
    title.textContent = concern.title;
    const detail = document.createElement('div');
    detail.className = 'set-desc';
    detail.textContent = concern.detail;
    row.append(title, detail);
    if (concern.fix !== undefined) {
      const fix = document.createElement('div');
      fix.className = 'set-desc set-concern-fix';
      fix.textContent = concern.fix;
      row.append(fix);
    }
    wrap.append(row);
  }
  const buttons = document.createElement('div');
  buttons.className = 'cmd-buttons';
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'cmd-button';
  again.textContent = 'Check again';
  again.addEventListener('click', () => {
    again.disabled = true;
    options.onRecheckAttention?.();
  });
  buttons.append(again);
  wrap.append(buttons);
  return wrap;
}

/**
 * Versions, a way to check and a way to update, and the two switches that do it unattended.
 *
 * Drawn with the same pieces as every other section: the buttons are the panel's own buttons and
 * the switches are rows with a checkbox on the right, the way Notifications has them. It used to
 * be bare browser buttons and bare checkboxes under a label, which was reported as looking out of
 * place, and it used to be the first section, which put the thing changed least often above
 * everything changed daily.
 */
function buildUpdates(options: SettingsOptions): HTMLElement {
  const updates = section('Updates');
  updates.dataset['updates'] = 'true';
  const state = options.updates?.();
  const versions = document.createElement('p');
  versions.className = 'set-desc';
  versions.textContent = `Extension ${VERSION} · Companion ${state?.installedVersion ?? options.companionVersion?.() ?? 'Connecting'}`;
  updates.append(versions);
  const message = document.createElement('p');
  message.className = 'set-desc';
  message.dataset['updateStatus'] = 'true';
  message.setAttribute('role', 'status');
  message.textContent = state
    ? state.message
    : 'If update controls do not appear, install the latest companion once using the setup guide.';
  updates.append(message);
  if (state) {
    if (state.availableVersion) {
      const available = document.createElement('p');
      available.className = 'set-desc';
      available.textContent = `Latest companion: ${state.availableVersion}${state.checkedAt ? ` · Checked ${new Date(state.checkedAt).toLocaleString()}` : ''}`;
      updates.append(available);
    }
    const busy = ['checking', 'preparing', 'installing'].includes(state.phase);
    const buttons = document.createElement('div');
    buttons.className = 'cmd-buttons';
    /*
     * Update companion is offered only when there is something to install: a release on GitHub
     * newer than the companion installed here, and compatible with it. Shown otherwise, it looked
     * like an update waiting even while the companion was up to date.
     */
    for (const [label, action, disabled, primary] of [
      ['Check for updates', options.onCheckUpdate, busy, false],
      ...(state.canInstall
        ? ([['Update companion', options.onInstallUpdate, busy, true]] as const)
        : []),
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = primary ? 'cmd-button primary' : 'cmd-button';
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', () => {
        button.disabled = true;
        action?.();
      });
      buttons.append(button);
    }
    updates.append(buttons);
    updates.append(
      toggle(
        'Check for updates automatically',
        state.automaticChecks,
        (value) => options.onUpdatePreferences?.(value, value && state.automaticInstall),
        'Asks GitHub once a day. Sends no terminal content.',
      ),
      toggle(
        'Install companion updates automatically',
        state.automaticInstall,
        (value) => options.onUpdatePreferences?.(state.automaticChecks || value, value),
        'When a new companion release works with this one, it is downloaded, built and installed for you. Terminals stay running. One that needs a manual step only says so.',
      ),
    );
  }
  const setup = document.createElement('a');
  setup.href = 'https://github.com/halvis82/TabTerm#setup';
  setup.target = '_blank';
  setup.rel = 'noopener noreferrer';
  setup.textContent = 'Companion setup guide';
  updates.append(setup);
  return updates;
}

/**
 * Remote access: these terminals from a phone or another computer, through the person's own relay.
 *
 * Off until turned on, and nothing here works until a relay address and its secret are entered,
 * which is the only part of the setup that happens outside TabTerm. Pairing is a code to scan: the
 * key travels inside it, so it never passes through the relay. See docs/17-remote-access.md.
 */
let relayOpen = false;

function buildRemote(options: SettingsOptions): HTMLElement | null {
  if (!options.remote) return null;
  const wrap = section('Remote access');
  wrap.dataset['remote'] = 'true';
  const state = options.remote();
  if (!state) {
    const pending = document.createElement('p');
    pending.className = 'set-desc';
    pending.textContent = 'Waiting for the daemon.';
    wrap.append(pending);
    return wrap;
  }

  // Once the relay is set up, the setup is out of the way: the switch, the status and pairing.
  const configured = state.relayUrl !== '' && state.hasSecret;

  const intro = document.createElement('p');
  intro.className = 'set-desc';
  intro.textContent =
    'Watch and type into these terminals from your phone or another computer, in a browser. ' +
    'It goes through a relay you run on your own free Cloudflare account, encrypted so the ' +
    'relay cannot read it. Every device you add unlocks with Face ID, Touch ID or its passcode. ' +
    'From a device you can never end a session or open anything on this Mac.';
  wrap.append(intro);

  const guide = document.createElement('a');
  guide.href = 'https://github.com/halvis82/TabTerm/blob/main/docs/17-remote-access.md';
  guide.target = '_blank';
  guide.rel = 'noopener noreferrer';
  guide.textContent = 'How to set up your relay, about five minutes';
  if (!configured) wrap.append(guide);

  wrap.append(
    toggle('Remote access', state.enabled, (on) => options.onRemoteSet?.({ enabled: on })),
  );

  const status = document.createElement('p');
  status.className = 'set-desc';
  status.setAttribute('role', 'status');
  status.dataset['remoteStatus'] = state.status;
  const browsers =
    state.browsers === 0
      ? ''
      : ` · ${String(state.browsers)} device${state.browsers === 1 ? '' : 's'} connected now`;
  status.textContent =
    state.status === 'connected'
      ? `Connected to your relay${browsers}`
      : state.status === 'connecting'
        ? 'Connecting to your relay'
        : state.status === 'error'
          ? (state.detail ?? 'Not connected')
          : 'Off';
  wrap.append(status);

  // The relay: its address, and its secret, which is written once and never shown again.
  const address = document.createElement('input');
  address.className = 'launcher-input set-input';
  address.spellcheck = false;
  address.placeholder = 'https://tabterm-relay.you.workers.dev';
  address.value = state.relayUrl;
  address.dataset['remoteUrl'] = 'true';
  const secret = document.createElement('input');
  secret.className = 'launcher-input set-input';
  secret.type = 'password';
  secret.autocomplete = 'off';
  secret.spellcheck = false;
  secret.placeholder = state.hasSecret ? 'Saved. Type a new one to replace it' : 'The relay secret';
  secret.dataset['remoteSecret'] = 'true';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'cmd-button';
  save.textContent = 'Save relay';
  save.addEventListener('click', () => {
    const change: { relayUrl: string; relaySecret?: string } = { relayUrl: address.value.trim() };
    if (secret.value.trim() !== '') change.relaySecret = secret.value.trim();
    secret.value = '';
    options.onRemoteSet?.(change);
  });
  const saveRow = document.createElement('div');
  saveRow.className = 'cmd-buttons';
  saveRow.append(save);
  const relayFields = [
    field('Relay address', 'The address your relay was given when you deployed it.', address),
    field(
      'Relay secret',
      'Lets only this Mac connect to your relay as this Mac. Set once, when the relay was ' +
        'deployed. Nobody needs to know it after that, and devices never use it.',
      secret,
    ),
    saveRow,
  ];
  if (configured) {
    const relay = document.createElement('details');
    relay.className = 'set-remote-relay';
    relay.dataset['remoteRelay'] = 'true';
    const summary = document.createElement('summary');
    let host = state.relayUrl;
    try {
      host = new URL(state.relayUrl).host;
    } catch {
      // Shown as it was typed.
    }
    summary.textContent = `Relay: ${host}`;
    relay.append(summary, ...relayFields);
    // Kept open across redraws while somebody is changing it.
    relay.open = relayOpen;
    relay.addEventListener('toggle', () => {
      relayOpen = relay.open;
    });
    wrap.append(relay);
  } else {
    wrap.append(...relayFields);
  }

  // Adding a device.
  const pairRow = document.createElement('div');
  pairRow.className = 'set-field';
  const pairLabel = document.createElement('span');
  pairLabel.className = 'set-label';
  pairLabel.textContent = 'Add a device';
  const pairNote = document.createElement('span');
  pairNote.className = 'set-desc';
  pairNote.textContent =
    'On the phone, open your relay and press Scan code, or scan it with the camera app. On ' +
    'another computer, open the link. It works once, for ten minutes. The device asks for Face ' +
    'ID, Touch ID or its passcode, and then this Mac asks you to approve it with Touch ID.';
  const pairButton = document.createElement('button');
  pairButton.type = 'button';
  pairButton.className = 'cmd-button primary';
  pairButton.textContent = 'Show a pairing code';
  pairButton.disabled = state.status !== 'connected';
  pairButton.addEventListener('click', () => options.onRemotePair?.());
  pairRow.append(pairLabel, pairNote, pairButton);
  const pairing = options.remotePairing?.();
  if (pairing && pairing.expiresAt > Date.now()) {
    pairRow.append(pairingCode(pairing));
  }
  wrap.append(pairRow);

  // The trusted devices.
  if (state.devices.length > 0) {
    const list = document.createElement('div');
    list.className = 'set-remote-devices';
    for (const device of state.devices) {
      const row = document.createElement('div');
      row.className = 'set-field';
      row.dataset['remoteDevice'] = device.id;
      // Named on the device when it was trusted, and renamed here: a web page cannot learn a
      // phone's own name, so this is how two iPhones are told apart.
      const name = document.createElement('input');
      name.className = 'launcher-input set-input set-remote-name';
      name.spellcheck = false;
      name.maxLength = 60;
      name.value = device.name;
      name.setAttribute('aria-label', 'Device name');
      name.dataset['remoteName'] = device.id;
      const rename = (): void => {
        const typed = name.value.trim();
        if (typed === '' || typed === device.name) {
          name.value = device.name;
          return;
        }
        options.onRemoteDevice?.({ deviceId: device.id, name: typed });
      };
      name.addEventListener('blur', rename);
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          name.blur();
        }
        // Not the terminal's, while somebody is typing in a box.
        e.stopPropagation();
      });
      const when = document.createElement('span');
      when.className = 'set-desc';
      when.textContent =
        `Added ${new Date(device.addedAt).toLocaleDateString()}` +
        (device.lastSeenAt === undefined ? '' : ` · Last used ${ago(device.lastSeenAt)}`) +
        (device.notify === true ? ' · Gets notifications' : '');
      row.append(
        name,
        when,
        toggle('Can type into terminals', device.typing, (typing) =>
          options.onRemoteDevice?.({ deviceId: device.id, typing }),
        ),
        confirming({
          label: 'Remove',
          description: '',
          confirm: `Yes, remove ${device.name}`,
          onConfirm: () => options.onRemoteDevice?.({ deviceId: device.id, forget: true }),
        }),
      );
      list.append(row);
    }
    wrap.append(field('Trusted devices', 'Removing one cuts it off at once.', list));
  }
  return wrap;
}

/** The code to scan, drawn as an SVG so it stays sharp, with the link under it. */
function pairingCode(pairing: { link: string; expiresAt: number }): HTMLElement {
  const box = document.createElement('div');
  box.className = 'set-pairing';
  box.dataset['remotePairing'] = 'true';
  const qr = qrcode(0, 'M');
  qr.addData(pairing.link);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(n + quiet * 2)} ${String(n + quiet * 2)}`);
  svg.setAttribute('width', '220');
  svg.setAttribute('height', '220');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Pairing code');
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${String(x + quiet)} ${String(y + quiet)}h1v1h-1z`;
    }
  }
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  const link = document.createElement('code');
  link.className = 'set-pairing-link';
  link.textContent = pairing.link;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cmd-button';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(pairing.link).then(() => (copy.textContent = 'Copied'));
  });
  const expires = document.createElement('span');
  expires.className = 'set-desc';
  expires.textContent = `Works once, until ${new Date(pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Anyone with this code can pair, so show it only to your own device.`;
  box.append(svg, expires, copy, link);
  return box;
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
        'Ends every terminal, and deletes history, saved commands, templates, highlights, ' +
        'every preference, and remote access with its relay and every paired device. TabTerm ' +
        'itself stays installed and starts as if it were new. There is no undo.',
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
      'Notify me when a command or an agent finishes',
      policy.enabled,
      (enabled) => options.onChangeNotify({ enabled }),
      'A macOS notification naming what finished.',
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
      'Only when it took longer than',
      'Quick commands finish before you have looked away, so they do not notify.',
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
        toggle('Notify for commands run in a shell', policy.commands, (commands) =>
          options.onChangeNotify({ commands }),
        ),
      ),
      nested(
        toggle('Notify when an agent finishes its turn', policy.agentTurns, (agentTurns) =>
          options.onChangeNotify({ agentTurns }),
        ),
      ),
      nested(
        toggle(
          'Not when that pane is already on screen',
          policy.onlyWhenUnfocused,
          (onlyWhenUnfocused) => options.onChangeNotify({ onlyWhenUnfocused }),
        ),
      ),
    );
  }

  return wrap;
}

/**
 * Agents: what launching one runs, and whether they report what they are doing. Apart from
 * notifications, where they used to sit, since they decide what an agent tab shows as well.
 */
function buildAgents(options: SettingsOptions): HTMLElement | null {
  const wrap = section('Agents');
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
        'Command that Launch an agent runs',
        'What Launch an agent in the command menu, and its keyboard shortcut, start in a new tab. ' +
          'Arguments are allowed, and quotes for a path with a space in it. Empty means claude.',
        box,
      ),
    );
  }

  const hooks = options.agentHooks();
  if (hooks) {
    wrap.append(
      toggle(
        'Show what agents are doing in their tabs',
        hooks.installed,
        options.onChangeAgentHooks,
        describeHooks(hooks),
      ),
    );
  }

  return wrap.children.length > 1 ? wrap : null;
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
  if (!hooks.installed) {
    return `Off: a tab cannot show that its agent is working, waiting for you or done, and agent turns cannot notify. On adds TabTerm to the agent's hooks${trailing}`;
  }
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
  return `On for ${names}: its tabs show when it is working, waiting for you or done. Set in ${where}, ${seen}${trailing}`;
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
    ? 'On: a line in ~/.zshrc tells TabTerm how each command ended, so a tab shows a tick or a cross. Open a new tab to apply'
    : 'Off: TabTerm sees that a command finished, not whether it failed. On adds one line to ~/.zshrc';
}
