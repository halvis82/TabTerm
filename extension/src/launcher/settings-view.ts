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
}

const THEMES: [value: string, label: string][] = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['midnight', 'Midnight'],
];

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
