import { getToken } from './transport/token.js';
import {
  installClickHandler,
  notify,
  workspaceIsOnScreen,
  type NotifyPriority,
} from './chrome/notifications.js';
import { buildAction } from './chrome/cross-actions.js';

/**
 * Service worker: dispatch only.
 *
 * Measured: this dies after roughly 40 seconds of idle, so it holds no connection and no
 * state. It wakes for a command, does one thing, and dies again. See ADR-0003.
 *
 * It is also the only context with the full extension API surface, so it fetches the daemon
 * token on behalf of the offscreen document, which is given only `chrome.runtime`.
 */
const OFFSCREEN_PATH = 'offscreen.html';
const CLIENT_ID_KEY = 'tabterm.clientId';

async function clientId(): Promise<string> {
  const got = await chrome.storage.local.get(CLIENT_ID_KEY);
  const existing = got[CLIENT_ID_KEY] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [CLIENT_ID_KEY]: id });
  return id;
}

// Chrome allows exactly one offscreen document, and getContexts can report zero while a
// create is still in flight. Two callers racing here both try to create, and the second
// throws. Memoizing the promise makes concurrent callers await the same creation.
let creating: Promise<void> | null = null;

async function createOffscreenOnce(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification:
      'Holds the long-lived local control connection the service worker cannot keep alive.',
  });
}

async function ensureOffscreen(): Promise<void> {
  creating ??= createOffscreenOnce().catch(() => {
    /* Another context won the race. That is the desired end state either way. */
  });
  await creating;
  const token = await getToken();
  if (!token) return;
  try {
    await chrome.runtime.sendMessage({
      t: 'tabterm:credentials',
      token,
      clientId: await clientId(),
    });
  } catch {
    /* The document asks for credentials itself if this races. */
  }
}

/**
 * Group colors Chrome accepts.
 *
 * `chrome.tabGroups` takes only this fixed enum, never an arbitrary hex value. Picking one by
 * hashing the project name keeps a given project the same color between sessions without
 * storing anything. See docs/10-limitations.md tier 1.5.
 */
const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = [
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'pink',
  'purple',
  'red',
];

function colorFor(name: string): chrome.tabGroups.ColorEnum {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length] as chrome.tabGroups.ColorEnum;
}

/**
 * Put a terminal in the right group.
 *
 * Inheriting the current tab's group is what makes a terminal land beside the work it belongs
 * to. When there is no group to inherit, nothing is created: silently grouping a lone tab
 * would be the extension rearranging a tab strip nobody asked it to touch.
 */
async function placeInGroup(
  createdTabId: number,
  sourceGroupId: number | undefined,
): Promise<void> {
  if (sourceGroupId === undefined || sourceGroupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  try {
    await chrome.tabs.group({ groupId: sourceGroupId, tabIds: [createdTabId] });
  } catch {
    /* the group may have closed between the query and here */
  }
}

/**
 * Group a terminal with its project, creating the group if needed.
 *
 * Only ever called from an explicit user action, never automatically on `cd`.
 */
export async function groupByProject(tabId: number, projectName: string): Promise<void> {
  const existing = await chrome.tabGroups.query({ title: projectName });
  const target = existing[0];
  if (target) {
    await chrome.tabs.group({ groupId: target.id, tabIds: [tabId] });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: projectName, color: colorFor(projectName) });
}

/**
 * Open a terminal at the end of the strip, the way Command+T does.
 *
 * It used to open beside the current tab, which is what "open a related thing" should do and is
 * wrong here: a terminal is not related to the page you happened to be reading. Chrome puts a new
 * tab at the end, and a terminal that behaves like a tab has to mean this too.
 *
 * A tab inside a group is the exception. There, the end of the strip is outside the group, and
 * being torn out of a group is a bigger surprise than not being last.
 */
async function openTerminal(): Promise<void> {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const grouped = current?.groupId !== undefined && current.groupId !== -1;
  const created = await chrome.tabs.create({
    url: chrome.runtime.getURL('terminal.html'),
    ...(grouped ? { index: current.index + 1 } : {}),
    active: true,
  });
  if (created.id !== undefined) await placeInGroup(created.id, current?.groupId);
}

interface NotifyMessage {
  t: string;
  port?: number;
  priority?: NotifyPriority;
  title?: string;
  body?: string;
  target?: { workspaceId?: string; paneId?: string };
  suppressIfVisible?: boolean;
  workspaceId?: string;
  attachHere?: boolean;
}

/**
 * Show a workspace, without ever creating a second view of one.
 *
 * A tab already holding it is focused. Only a workspace with no tab gets a new one, which is the
 * case the session list exists for.
 */
/** The tab showing one workspace, closed because its session has just been ended. */
async function closeWorkspaceTab(workspaceId: string, asking?: number): Promise<void> {
  const base = chrome.runtime.getURL('terminal.html');
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  const ids = tabs
    .filter((t) => t.url?.includes(workspaceId))
    .map((t) => t.id)
    .filter((id): id is number => id !== undefined && id !== asking);
  if (ids.length > 0) await chrome.tabs.remove(ids);
}

/** Every terminal tab except the one asking, which is showing the result. */
async function closeOtherTerminalTabs(keep?: number): Promise<void> {
  const base = chrome.runtime.getURL('terminal.html');
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined && id !== keep);
  if (ids.length > 0) await chrome.tabs.remove(ids);
}

async function focusOrOpenWorkspace(workspaceId: string, attachHere: boolean): Promise<void> {
  const base = chrome.runtime.getURL('terminal.html');
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  const existing = tabs.find((t) => t.url?.includes(workspaceId));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  if (!attachHere) return;
  await chrome.tabs.create({ url: `${base}?workspace=${workspaceId}`, active: true });
}

chrome.runtime.onMessage.addListener((msg: NotifyMessage, _sender, sendResponse) => {
  // Raised by the offscreen document, which holds the daemon connection but has only
  // chrome.runtime and cannot fire a notification itself.
  if (msg.t === 'tabterm:notify' && msg.title && msg.body) {
    const request = {
      priority: msg.priority ?? 'important',
      title: msg.title,
      body: msg.body,
      ...(msg.target ? { target: msg.target } : {}),
      ...(msg.suppressIfVisible === true ? { suppressIfVisible: true } : {}),
    };
    // Being told about a command you watched finish is how people turn notifications off.
    void workspaceIsOnScreen(msg.target?.workspaceId).then((visible) => notify(request, visible));
    sendResponse({ ok: true });
    return false;
  }

  if (msg.t === 'tabterm:close-workspace-tab' && msg.workspaceId) {
    void closeWorkspaceTab(msg.workspaceId, _sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.t === 'tabterm:close-other-terminals') {
    // Closing tabs is the worker's job: a page cannot close its siblings.
    void closeOtherTerminalTabs(_sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.t === 'tabterm:count-terminal-tabs') {
    void chrome.tabs
      .query({ url: `${chrome.runtime.getURL('terminal.html')}*` })
      .then((tabs) => sendResponse({ count: tabs.length }));
    return true;
  }

  if (msg.t === 'tabterm:reload-extension') {
    // Last step of a reset, and the reason it is last: nothing after this runs.
    setTimeout(() => chrome.runtime.reload(), 300);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.t === 'tabterm:focus-workspace' && msg.workspaceId) {
    // Only the worker can move between tabs, so the page asks it to.
    void focusOrOpenWorkspace(msg.workspaceId, msg.attachHere === true);
    sendResponse({ ok: true });
    return false;
  }

  // A bare ping exists only to wake this worker, which is a side effect of any message.
  if (msg.t === 'tabterm:ping-for-wake') {
    sendResponse({ ok: true });
    return false;
  }

  // A server the terminal detected. Focusing an existing tab rather than opening a second one
  // matters here: a dev server restarts constantly, and each restart would otherwise leave
  // another tab behind.
  if (msg.t === 'tabterm:open-local' && typeof msg.port === 'number') {
    void openOrFocusLocal(msg.port);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.t !== 'tabterm:need-credentials') return false;
  void (async () => {
    sendResponse({ token: await getToken(), clientId: await clientId() });
  })();
  return true; // keep the channel open for the async reply
});

/**
 * Context-menu actions from a webpage into a terminal.
 *
 * Menus are rebuilt on install and on every wake, because a service worker that died loses
 * nothing here but a worker that never registered them shows no menu at all. `removeAll` first
 * makes that idempotent rather than an error about duplicate ids.
 *
 * Every action opens a terminal with the command **staged, not run**. See docs/05-security.md §4.
 */
function installContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'send-selection',
      title: 'Send selection to a terminal',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'clone-repo',
      title: 'Clone this repository in a terminal',
      contexts: ['page', 'link'],
      documentUrlPatterns: [
        'https://github.com/*',
        'https://gitlab.com/*',
        'https://bitbucket.org/*',
        'https://codeberg.org/*',
      ],
    });
    chrome.contextMenus.create({
      id: 'open-url',
      title: 'Fetch this link in a terminal',
      contexts: ['link'],
    });
    /**
     * Settings, from a right click on the toolbar icon.
     *
     * It opens a terminal tab with the panel already on settings rather than a page of its own,
     * because every setting here is about how a terminal behaves and is worth changing while
     * looking at one.
     */
    chrome.contextMenus.create({
      id: 'open-settings',
      title: 'TabTerm settings',
      contexts: ['action'],
    });

    /**
     * The way out when something has gone wrong.
     *
     * The ellipsis is doing real work: this opens a confirmation rather than acting, because it
     * sits next to Settings on the same icon and the cost of a misclick is somebody's running
     * work.
     */
    chrome.contextMenus.create({
      id: 'reset-tabterm',
      title: 'End all sessions and close tabs...',
      contexts: ['action'],
    });
    // A menu id that failed to register is worth knowing about, and is otherwise invisible.
    if (chrome.runtime.lastError) {
      console.warn('TabTerm: context menus', chrome.runtime.lastError.message);
    }
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  const id = String(info.menuItemId);
  if (id === 'reset-tabterm') {
    void chrome.tabs.create({ url: `${chrome.runtime.getURL('terminal.html')}?panel=reset` });
    return;
  }
  if (id === 'open-settings') {
    void chrome.tabs.create({
      url: `${chrome.runtime.getURL('terminal.html')}?panel=settings`,
      active: true,
    });
    return;
  }
  if (id !== 'send-selection' && id !== 'clone-repo' && id !== 'open-url') return;
  const action = buildAction(id, {
    ...(info.selectionText ? { selectionText: info.selectionText } : {}),
    ...(info.pageUrl ? { pageUrl: info.pageUrl } : {}),
    ...(info.linkUrl ? { linkUrl: info.linkUrl } : {}),
  });
  // Nothing usable came out of it. Opening an empty terminal would be a worse answer than
  // doing nothing, because it would look like the action worked.
  if (!action) return;
  void openTerminalWithStaged(action);
});

/**
 * Open a terminal with a command waiting for confirmation.
 *
 * The command travels in the URL rather than in a message, so it survives the worker dying
 * between the click and the page loading, which it routinely does.
 */
async function openTerminalWithStaged(action: {
  id: string;
  text: string;
  source: string;
}): Promise<void> {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(chrome.runtime.getURL('terminal.html'));
  url.searchParams.set('staged', action.text);
  url.searchParams.set('stagedFrom', action.source);
  // This one keeps its position beside the current tab on purpose: it was opened *about* that
  // page, unlike a plain new terminal.
  const created = await chrome.tabs.create({
    url: url.toString(),
    index: current ? current.index + 1 : undefined,
    active: true,
  });
  if (created.id !== undefined) await placeInGroup(created.id, current?.groupId);
}

/**
 * Open a detected local server, or focus the tab already showing it.
 *
 * Matching is by host and port, ignoring the path, because a single-page app changes its own
 * path and would otherwise never look like the same server twice.
 */
async function openOrFocusLocal(port: number): Promise<void> {
  const url = `http://localhost:${String(port)}/`;
  const existing = await chrome.tabs.query({
    url: [`http://localhost:${String(port)}/*`, `http://127.0.0.1:${String(port)}/*`],
  });
  const hit = existing[0];
  if (hit?.id !== undefined) {
    await chrome.tabs.update(hit.id, { active: true });
    if (hit.windowId !== undefined) await chrome.windows.update(hit.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

chrome.runtime.onInstalled.addListener(() => installContextMenus());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
chrome.commands.onCommand.addListener((command) => {
  if (command === 'new-terminal' || command === 'new-terminal-alt') void openTerminal();
});

/**
 * Report which shortcut, if any, Chrome actually bound.
 *
 * Manifest acceptance is not assignment: Chrome silently declines keys it reserves, and the
 * reserved set is not documented. Without this the failure is invisible, which is exactly how
 * it presented the first time. See docs/10-limitations.md tier 1.8.
 */
async function reportShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const bound = commands.filter((c) => c.shortcut);
  await chrome.storage.local.set({
    'tabterm.shortcuts': commands.map((c) => ({ name: c.name, shortcut: c.shortcut ?? '' })),
  });
  if (bound.length === 0) {
    console.warn(
      'TabTerm: Chrome bound no keyboard shortcut. Set one at chrome://extensions/shortcuts',
    );
  }
}
chrome.action.onClicked.addListener(() => void openTerminal());

// Clicking a notification focuses the tab that owns the workspace, so this must be registered
// every time the worker wakes, not once at install.
installClickHandler();
installContextMenus();
void ensureOffscreen();
void reportShortcuts();
