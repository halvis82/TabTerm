import { daemonPort } from './transport/port.js';
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
      port: await daemonPort(),
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

/**
 * Tell the daemon which workspaces Chrome still has a tab for.
 *
 * This is the whole answer to "a session expired while its tab was open". The daemon can only
 * see sockets, and a socket is not a tab: a backgrounded tab, one in a collapsed group, one on a
 * machine that slept, and one Chrome discarded to save memory all look identical from the
 * daemon's side, and none of them means the person is finished with that terminal.
 *
 * The URL carries the workspace id, so no bookkeeping is needed: what Chrome reports is the
 * truth by construction. A tab with no workspace in its URL has not been given one yet and is
 * counted as nothing, which is correct: it has no session to protect.
 */
const OPEN_TABS_KEY = 'tabterm.openWorkspaces';

/**
 * Nothing may overwrite the remembered set until startup has decided what to reopen.
 *
 * The record is at its most precious in the first moment of a worker's life, because that is
 * exactly when the tabs it names do not exist yet. A tab event arriving first, and any event
 * will, made `reportOpenTabs` write the truthful answer of "no terminal tabs" over the list of
 * the ones that had just been destroyed, and the reopen then read an empty list and did nothing.
 *
 * That is why this feature had never been seen working: not a missing trigger, a race with a
 * report that was correct in isolation and wrong at that instant.
 */
let startupSettled: Promise<void> = Promise.resolve();

/**
 * Workspaces to keep claiming as open even though no tab shows them yet.
 *
 * Held only between the extension starting and its tabs being put back. In that gap the truthful
 * answer and the useful one differ: the tabs are genuinely gone, and saying so ends the shells in
 * them thirty seconds later, for a reload nobody asked to be destructive.
 */
let claimedWhileStarting: string[] = [];

async function reportOpenTabs(): Promise<void> {
  try {
    await startupSettled;
    const base = chrome.runtime.getURL('terminal.html');
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    const workspaceIds = tabs
      .map((t) => new URL(t.url ?? '').searchParams.get('workspace'))
      .filter((id): id is string => id !== null && id !== '');
    // Kept as well as sent, so the tabs can be put back after a reload. See `reopenAfterReload`.
    await chrome.storage.local.set({ [OPEN_TABS_KEY]: workspaceIds });
    await sendTabsOpen([...new Set([...workspaceIds, ...claimedWhileStarting])]);
  } catch {
    /**
     * Silent, and safe when it fails.
     *
     * A report that does not arrive leaves the daemon on its previous answer, or on "nobody has
     * told me", and both of those keep the terminal. The failure direction is never towards
     * ending one.
     */
  }
}

/**
 * Sent until it is actually taken, rather than once into whatever is listening.
 *
 * The offscreen document is what holds the connection to the daemon, and right after the
 * extension starts it may not exist yet or may not have connected. `sendMessage` then throws, or
 * lands somewhere with no connection to forward it, and the report is simply lost. The next one
 * was two minutes later, which is four times longer than the fastest rule that ends a terminal:
 * a report system whose retry is slower than the thing it protects against.
 */
async function sendTabsOpen(workspaceIds: readonly string[]): Promise<void> {
  // The document that forwards it may not exist yet, and asking for it is what creates it.
  await ensureOffscreen().catch(() => undefined);
  for (const wait of [0, 250, 750, 2000, 5000]) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const reply: unknown = await chrome.runtime.sendMessage({
        t: 'tabterm:tabs-open',
        workspaceIds,
      });
      // The offscreen document answers only once it has a connection to send it on.
      if (typeof reply === 'object' && reply !== null && (reply as { sent?: boolean }).sent) return;
    } catch {
      /* No receiver yet. That is what the next attempt is for. */
    }
  }
}

/**
 * Reported on every change, and on a slow poll as well.
 *
 * The events cover the ordinary cases. The poll covers the ones that are not events at all: the
 * service worker having been asleep when a tab closed, a report lost while the daemon was
 * restarting, and the extension having only just started. Two minutes is far below the shortest
 * time anything is kept, so a missed event costs nothing.
 */
const TAB_REPORT_MS = 120_000;

/**
 * Put the tabs back after the extension is reloaded or updated.
 *
 * Chrome destroys every page belonging to an extension when it is reloaded, so the terminal tabs
 * vanish. The terminals themselves are untouched: they live in the PTY host, which is a separate
 * process that knows nothing about Chrome. Reopening the workspace URL finds the session exactly
 * as it was, which is verified rather than assumed.
 *
 * So the tabs come back on their own. Without this the sessions were alive, reachable and
 * invisible, and getting to them meant knowing that the start screen lists them, which is not
 * something a person should have to know after pressing reload.
 *
 * Only what was open at the moment the extension went away. The remembered set is rewritten on
 * every report, so a tab somebody closed is already out of it and is not resurrected.
 */
async function reopenAfterReload(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(OPEN_TABS_KEY);
    const wanted: unknown = stored[OPEN_TABS_KEY];
    if (!Array.isArray(wanted) || wanted.length === 0) return;

    /**
     * Claimed before a single tab is created, which is the half that keeps the terminals.
     *
     * Putting the tabs back was written as the whole answer to a reload, and it is not: between
     * Chrome destroying them and this function finishing, the daemon is told the truth, that no
     * tab shows these workspaces, and an untouched pane is ended thirty seconds later. Five of
     * them went that way in one second on 2026-09-04. Saying so first costs nothing if the
     * reopen works, and saves the shells if it does not.
     */
    claimedWhileStarting = wanted.filter((id): id is string => typeof id === 'string');
    void sendTabsOpen(claimedWhileStarting);

    const base = chrome.runtime.getURL('terminal.html');
    const open = await chrome.tabs.query({ url: `${base}*` });
    const already = new Set(
      open.map((t) => new URL(t.url ?? '').searchParams.get('workspace')).filter(Boolean),
    );
    for (const id of wanted) {
      if (typeof id !== 'string' || already.has(id)) continue;
      // Not focused: several coming back at once should not fight over which is in front, and
      // a reload is not a request to be taken somewhere.
      await chrome.tabs.create({ url: `${base}?workspace=${id}`, active: false });
    }

    /**
     * The claim is given up once the tabs it stood in for exist, and never held indefinitely.
     *
     * A claim that outlived its purpose would keep every workspace it named alive forever,
     * including ones somebody then closed on purpose, which is the opposite failure and just as
     * wrong. The grace exists for the case where a tab could not be recreated at all: the
     * session is then listed on the start screen, and a couple of minutes is enough to notice.
     */
    const back = await chrome.tabs.query({ url: `${base}*` });
    const shown = new Set(
      back.map((t) => new URL(t.url ?? '').searchParams.get('workspace')).filter(Boolean),
    );
    const stillMissing = claimedWhileStarting.filter((id) => !shown.has(id));
    claimedWhileStarting = stillMissing;
    if (stillMissing.length > 0) {
      setTimeout(() => {
        claimedWhileStarting = [];
        void reportOpenTabs();
      }, CLAIM_GRACE_MS);
    }
  } catch {
    /* A tab that could not be reopened is still reachable from the start screen. */
  }
}

/** How long a workspace nobody could put a tab back for is still claimed as open. */
const CLAIM_GRACE_MS = 120_000;

chrome.tabs.onRemoved.addListener(() => void reportOpenTabs());
chrome.tabs.onCreated.addListener(() => void reportOpenTabs());
chrome.tabs.onUpdated.addListener((_id, changed) => {
  // Only when the URL changed: a title or a favicon says nothing about which workspaces exist.
  if (changed.url !== undefined) void reportOpenTabs();
});
chrome.tabs.onReplaced.addListener(() => void reportOpenTabs());
chrome.runtime.onStartup.addListener(() => void reopenAfterReload().then(() => reportOpenTabs()));
/**
 * An update and a fresh install land here. A reload does not, which is the whole defect.
 *
 * `onInstalled` and `onStartup` were the only two triggers, and neither fires when the extension
 * is reloaded rather than updated or installed. So the tabs were destroyed and nothing put them
 * back, and it looked handled because the code for putting them back was plainly there and had
 * never been watched doing it.
 */
chrome.runtime.onInstalled.addListener(() => {
  void reopenAfterReload().then(() => reportOpenTabs());
});

/**
 * Has this extension only just started, or did its service worker merely wake up?
 *
 * The two are indistinguishable from inside the worker: both are a fresh global scope running
 * this file from the top. `chrome.storage.session` tells them apart because it is cleared when
 * the extension is reloaded, updated, or the browser restarts, and **kept** across the worker
 * being torn down and started again, which is the one thing that happens constantly.
 *
 * So an absent marker means the extension itself is new here, which is exactly when its tabs
 * have just been destroyed. Getting this wrong in the other direction would reopen a tab
 * somebody had closed a moment earlier, every thirty seconds, forever.
 */
const AWAKE_KEY = 'tabterm.workerAwake';

async function reopenIfTheExtensionJustStarted(): Promise<void> {
  try {
    const seen = await chrome.storage.session.get(AWAKE_KEY);
    if (seen[AWAKE_KEY] === true) return;
    await chrome.storage.session.set({ [AWAKE_KEY]: true });
    await reopenAfterReload();
  } catch {
    /* Session storage is unavailable in some contexts. Reopening is a convenience. */
  }
}

/**
 * Assigned before anything can report, so the first report waits for this rather than racing it.
 *
 * The listeners above are already registered by the time this line runs, and an event can arrive
 * between the two. Holding the gate from here means it does not matter which order they land in.
 */
startupSettled = reopenIfTheExtensionJustStarted();
void startupSettled.then(() => reportOpenTabs());
void chrome.alarms.create('tabterm:tab-report', { periodInMinutes: TAB_REPORT_MS / 60_000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tabterm:tab-report') void reportOpenTabs();
});
void reportOpenTabs();

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
    /**
     * Write down which tabs are open, then reload. In that order.
     *
     * A reload destroys every page this extension owns, and what brings them back is the record
     * of which workspaces had tabs. That record is written on tab events and on a slow alarm, so
     * a tab opened a moment ago while the worker was asleep may not be in it yet. Reloading
     * first and asking afterwards is asking a process that no longer exists.
     *
     * Last step of whatever asked for it, and the reason it is last: nothing after this runs.
     */
    void reportOpenTabs().finally(() => setTimeout(() => chrome.runtime.reload(), 300));
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
    /**
     * The port travels with the credentials, because the document cannot read it.
     *
     * An offscreen document is given only `chrome.runtime`: no `chrome.storage`. So its call to
     * `daemonPort()` always threw, always fell back to the default, and the control connection
     * always went to 7377 whatever the installation was configured for. Under the browser
     * suites that meant every notification, every tab report and every session list came from
     * the daemon somebody was working in rather than the one the run had started.
     */
    sendResponse({ token: await getToken(), clientId: await clientId(), port: await daemonPort() });
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
  /**
   * One entry, with its own error check.
   *
   * `chrome.runtime.lastError` is cleared by the next call that succeeds, so a single check
   * after five creates reports whether the last one failed and nothing about the others. Two
   * entries went missing while that check said nothing, which is worse than no check at all
   * because it looked like proof they were fine.
   */
  const add = (properties: chrome.contextMenus.CreateProperties): void => {
    chrome.contextMenus.create(properties, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          `TabTerm: context menu "${String(properties.id)}"`,
          chrome.runtime.lastError.message,
        );
      }
    });
  };

  chrome.contextMenus.removeAll(() => {
    add({
      id: 'send-selection',
      title: 'Send selection to a terminal',
      contexts: ['selection'],
    });
    add({
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
    add({
      id: 'open-url',
      title: 'Fetch this link in a terminal',
      contexts: ['link'],
    });
    /**
     * Opening a terminal, first, because it is what somebody reaching for this icon wants.
     *
     * The icon's own click already does it. Having it in the menu too costs a line and means the
     * menu is never a dead end: everything else here is about configuring or ending things.
     */
    add({
      id: 'new-terminal-tab',
      title: 'New TabTerm terminal',
      contexts: ['action'],
    });
    /**
     * Settings, from a right click on the toolbar icon.
     *
     * It opens a terminal tab with the panel already on settings rather than a page of its own,
     * because every setting here is about how a terminal behaves and is worth changing while
     * looking at one.
     */
    add({
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
    /**
     * Where shortcuts are changed, which is a Chrome page and cannot be anywhere else.
     *
     * Under Settings rather than beside it: it is a setting, it is just one Chrome owns.
     */
    add({
      id: 'edit-shortcuts',
      title: 'Edit keyboard shortcuts',
      contexts: ['action'],
    });
    add({
      id: 'reset-tabterm',
      title: 'End all sessions and close tabs...',
      contexts: ['action'],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  const id = String(info.menuItemId);
  if (id === 'reset-tabterm') {
    void chrome.tabs.create({ url: `${chrome.runtime.getURL('terminal.html')}?panel=reset` });
    return;
  }
  if (id === 'new-terminal-tab') {
    void openTerminal();
    return;
  }
  if (id === 'edit-shortcuts') {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
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
/**
 * Chrome's shortcuts, forwarded to whichever terminal is in front.
 *
 * A command fires here, in the worker, and not in the page, so anything that acts on a terminal
 * has to be relayed.
 *
 * Only what is worth being global. Splitting a pane and opening the command menu were declared
 * here too, which put them in `chrome://extensions/shortcuts` as keys that apply to the whole
 * browser: three rows about panes, offered while reading mail, for a window that may hold no
 * terminal at all. They belong to a terminal, so they are bound inside one, on the settings
 * panel's Keyboard shortcuts, where they can also be changed without leaving the product.
 *
 * Launching an agent stays, because it is the one that makes sense from anywhere: it opens a tab
 * rather than acting on one.
 */
const FORWARDED: Record<string, string> = {
  'launch-agent': 'tabterm:launch-agent',
};

chrome.commands.onCommand.addListener((command) => {
  if (command === 'new-terminal') {
    void openTerminal();
    return;
  }
  const forwarded = FORWARDED[command];
  if (!forwarded) return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const base = chrome.runtime.getURL('terminal.html');
    // Only to a terminal. Sending a split to whatever page happens to be in front would be a
    // message to somebody else's tab about something it knows nothing about.
    if (!tab?.id || !tab.url?.startsWith(base)) {
      if (command === 'launch-agent') void openTerminal();
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { t: forwarded });
    } catch {
      // A terminal tab that is not listening is one that has been discarded. Nothing to do.
    }
  })();
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
