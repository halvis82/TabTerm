/**
 * What a right click offers, as a list rather than as a sequence of calls.
 *
 * Written this way because there is no way to read it back: `chrome.contextMenus` has no `getAll`
 * in a manifest v3 worker, so a menu built by five calls in a row can only be checked by opening
 * it and looking, and two entries once went missing while a check said nothing. A list is a value,
 * and a value can be asserted about.
 *
 * The order matters and is part of what is asserted. Chrome puts its own name at the top of the
 * icon's menu and nothing can go above it, so the first entry here is the first of ours.
 */

export interface MenuEntry {
  id: string;
  title: string;
  contexts: chrome.contextMenus.ContextType[];
  documentUrlPatterns?: string[];
}

/**
 * The icon's menu, in order.
 *
 * Opening a terminal first, because it is what somebody reaching for this icon wants, and because
 * it means the menu is never a dead end: everything else on it configures or ends things.
 *
 * Launching an agent next, because it is a thing you do rather than a thing you configure. It
 * runs whatever the agent command in settings says and opens its own tab, which is why it makes
 * sense from anywhere, including a window with no terminal in it.
 *
 * The ellipsis on the last is doing real work: it opens a confirmation rather than acting,
 * because it sits next to Settings on the same icon and the cost of a misclick is somebody's
 * running work.
 */
export const ICON_MENU: readonly MenuEntry[] = [
  { id: 'new-terminal-tab', title: 'New TabTerm terminal', contexts: ['action'] },
  { id: 'launch-agent-tab', title: 'Launch an agent in a new tab', contexts: ['action'] },
  { id: 'open-settings', title: 'TabTerm settings', contexts: ['action'] },
  // Under Settings rather than beside it: it is a setting, it is just one Chrome owns.
  { id: 'edit-shortcuts', title: 'Edit keyboard shortcuts', contexts: ['action'] },
  { id: 'reset-tabterm', title: 'End all sessions and close tabs...', contexts: ['action'] },
];

/**
 * The entries that belong to a page, which is where they stay.
 *
 * Sending a selection or cloning a repository need a page that has one. Offering them on the icon
 * would be offering them everywhere, including where they cannot mean anything.
 */
export const PAGE_MENU: readonly MenuEntry[] = [
  { id: 'send-selection', title: 'Send selection to a terminal', contexts: ['selection'] },
  {
    id: 'clone-repo',
    title: 'Clone this repository in a terminal',
    contexts: ['page', 'link'],
    documentUrlPatterns: [
      'https://github.com/*',
      'https://gitlab.com/*',
      'https://bitbucket.org/*',
      'https://codeberg.org/*',
    ],
  },
  { id: 'open-url', title: 'Fetch this link in a terminal', contexts: ['link'] },
];

/** Everything, in the order it is registered. Page entries first, as they always were. */
export const ALL_MENU: readonly MenuEntry[] = [...PAGE_MENU, ...ICON_MENU];
