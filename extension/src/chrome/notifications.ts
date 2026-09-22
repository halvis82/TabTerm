/**
 * Desktop notifications, fired from the offscreen document.
 *
 * They must reach the user when every terminal tab is hidden or discarded, and a discarded tab
 * has no page left to fire anything from. The offscreen document is the only context that
 * survives both. See docs/06-chrome-integration.md §7 and ADR-0003.
 *
 * macOS Do Not Disturb is honored by the system and cannot be queried, so this is fire and
 * forget: there is no way to learn whether a notification was actually shown. See tier 1.4.
 */

export type NotifyPriority = 'critical' | 'important' | 'low';

export interface NotifyRequest {
  priority: NotifyPriority;
  title: string;
  body: string;
  /** Where to send the user when they click it. */
  target?: { workspaceId?: string; paneId?: string };
  /** Suppressed when the pane in question is already on screen. */
  suppressIfVisible?: boolean;
}

/**
 * Click targets, kept so a click focuses the right tab rather than guessing.
 *
 * In session storage rather than in a map, because this runs in the service worker and the worker
 * dies after about thirty seconds of quiet. A notification that outlives it would otherwise lose
 * the only record of where it points, and clicking it would do nothing. That is the same shape as
 * the background deadline that was erased every time the worker slept, and it matters more now
 * that a notification is meant to sit there until its tab is looked at.
 */
const TARGETS_KEY = 'tabterm.notifyTargets';

type NotifyTarget = { workspaceId?: string; paneId?: string };

async function readTargets(): Promise<Record<string, NotifyTarget>> {
  try {
    const held = (await chrome.storage.session.get(TARGETS_KEY)) as Record<string, unknown>;
    const value = held[TARGETS_KEY];
    return typeof value === 'object' && value !== null
      ? (value as Record<string, NotifyTarget>)
      : {};
  } catch {
    // Storage can refuse mid-shutdown. An empty map means a click does nothing, which is the
    // harmless direction: the alternative is throwing inside a notification handler.
    return {};
  }
}

async function rememberTarget(id: string, target: NotifyTarget): Promise<void> {
  try {
    const all = await readTargets();
    all[id] = target;
    await chrome.storage.session.set({ [TARGETS_KEY]: all });
  } catch {
    /* See readTargets. */
  }
}

async function forgetTarget(id: string): Promise<void> {
  try {
    const all = await readTargets();
    if (!(id in all)) return;
    delete all[id];
    await chrome.storage.session.set({ [TARGETS_KEY]: all });
  } catch {
    /* See readTargets. */
  }
}

/**
 * Take back every notification that was pointing at this workspace.
 *
 * Called when its tab is looked at or goes away, which are the two ways the thing the
 * notification was about stops being news.
 */
export async function clearNotificationsFor(workspaceId: string): Promise<void> {
  const all = await readTargets();
  const mine = Object.keys(all).filter((id) => all[id]?.workspaceId === workspaceId);
  if (mine.length === 0) return;
  for (const id of mine) {
    delete all[id];
    void chrome.notifications.clear(id);
  }
  try {
    await chrome.storage.session.set({ [TARGETS_KEY]: all });
  } catch {
    /* See readTargets. */
  }
}

/**
 * Low-priority events never become desktop notifications.
 *
 * A short command finishing, or a shell going idle, is exactly the sort of thing that makes
 * people turn notifications off entirely. Those states belong in the favicon and the title.
 */
export function shouldNotify(req: NotifyRequest, paneIsVisible: boolean): boolean {
  if (req.priority === 'low') return false;
  if (req.suppressIfVisible === true && paneIsVisible) return false;
  return true;
}

export async function notify(req: NotifyRequest, paneIsVisible = false): Promise<string | null> {
  if (!shouldNotify(req, paneIsVisible)) return null;

  /**
   * One notification per tab, replaced rather than stacked.
   *
   * The id is the workspace, so Chrome updates the notice that tab already has instead of adding
   * another beside it. Three commands finishing in one terminal used to be three notices, and a
   * morning of them was a column to clear by hand: "i see a lot of stale ones. i keep having to
   * remove them. because they stack ... only one notification at most per tab".
   *
   * The newest is also the true one. What a tab has to say is its latest state, not a history of
   * the states it passed through, and the older notice is describing a moment that has gone.
   *
   * Anything with no tab behind it keeps a unique id: there is nothing to replace and nothing to
   * go to, and those are withdrawn on a timer instead.
   */
  const workspaceId = req.target?.workspaceId;
  const id =
    typeof workspaceId === 'string' && workspaceId !== ''
      ? `tabterm:tab:${workspaceId}`
      : `tabterm:${String(Date.now())}:${Math.random().toString(36).slice(2, 8)}`;
  /**
   * A notification that can take you somewhere stays until it has.
   *
   * It used to be withdrawn after eight seconds, on the reasoning that a notification exists to
   * interrupt once and a day of finished commands should not become a list to clear. The cost of
   * that was the case it was meant to serve: an agent finishing while somebody is in another
   * application produced a notice that was gone before they looked, so the thing they were told
   * about was never told to them at all.
   *
   * So it is kept, and taken back at the moment it stops being news: its tab is looked at, or its
   * tab is gone, or somebody clicks it. A notification with nowhere to go has none of those
   * moments, so it keeps the timer, because nothing else would ever remove it.
   */
  const canBeVisited = typeof workspaceId === 'string' && workspaceId !== '';
  if (req.target) await rememberTarget(id, req.target);

  const created = await new Promise<boolean>((resolve) => {
    try {
      chrome.notifications.create(
        id,
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon128.png'),
          title: req.title,
          message: req.body,
          priority: req.priority === 'critical' ? 2 : 1,
          requireInteraction: canBeVisited || req.priority === 'critical',
          // Said rather than assumed. Clicking has always opened the tab and nothing on the
          // notification admitted it, so the useful half of it went unused.
          ...(canBeVisited ? { contextMessage: 'Click to open this tab' } : {}),
        },
        () => resolve(chrome.runtime.lastError === undefined),
      );
    } catch {
      resolve(false);
    }
  });

  if (!created) {
    // An icon that failed to load, or notifications denied at the OS level. Neither is worth
    // breaking anything over, and there is no way to ask in advance whether they are allowed.
    await forgetTarget(id);
    return null;
  }

  /**
   * The timer is only for a notification nobody can ever visit.
   *
   * A timer rather than an alarm, because the shortest alarm Chrome allows is thirty seconds and
   * this is about eight. The worker can die first, and then the notification simply stays, which
   * is the same outcome as one that points somewhere.
   */
  if (!canBeVisited && req.priority !== 'critical') {
    setTimeout(() => {
      void forgetTarget(id);
      void chrome.notifications.clear(id);
    }, AUTO_CLEAR_MS);
  }
  return id;
}

/** Long enough to read a line of text and glance at it, short enough not to be a list. */
const AUTO_CLEAR_MS = 8000;

/**
 * Is the pane this is about already on screen?
 *
 * Only the extension can answer this: the daemon knows what happened, not who is watching. A
 * tab counts as being looked at when it is the active tab of a focused window, so a terminal
 * sitting in a background window still notifies.
 */
export async function workspaceIsOnScreen(workspaceId: string | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  try {
    const base = chrome.runtime.getURL('terminal.html');
    const tabs = await chrome.tabs.query({ url: `${base}*`, active: true });
    const hit = tabs.find((t) => t.url?.includes(workspaceId));
    if (hit?.windowId === undefined) return false;
    const window = await chrome.windows.get(hit.windowId);
    return window.focused === true;
  } catch {
    // Chrome can refuse any of this mid-shutdown. Assuming nobody is watching means the
    // notification is sent, which is the harmless direction to be wrong in.
    return false;
  }
}

export function installClickHandler(): void {
  chrome.notifications.onClicked.addListener((id) => {
    void (async () => {
      const target = (await readTargets())[id];
      await forgetTarget(id);
      void chrome.notifications.clear(id);
      if (!target?.workspaceId) return;
      await focusWorkspaceTab(target.workspaceId);
    })();
  });

  chrome.notifications.onClosed.addListener((id) => {
    void forgetTarget(id);
  });

  /**
   * And taken back when its tab is reached some other way.
   *
   * Registered at the top level so the worker is woken for them, which is the whole reason this
   * can work at all: the worker is usually dead by the time somebody switches tabs, and a
   * listener added later would never run.
   *
   * Three ways a tab stops being unread. Switching to it, which is `onActivated`. Bringing
   * forward the window it is already the active tab of, which `onActivated` does not fire for.
   * And closing it, which means whatever it was going to say is moot.
   */
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void clearForTab(tabId);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearForTab(tabId, closedTabs.get(tabId));
    closedTabs.delete(tabId);
  });

  /*
   * A removed tab cannot be read, so its workspace is remembered while it is still there.
   *
   * `onUpdated` is where a terminal tab first gets its URL, and it is the only chance to learn
   * which workspace a tab holds before the tab is gone.
   */
  chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
    const workspaceId = workspaceOf(tab.url);
    if (workspaceId) closedTabs.set(tabId, workspaceId);
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void (async () => {
      try {
        const [active] = await chrome.tabs.query({ active: true, windowId });
        if (active?.id !== undefined) await clearForTab(active.id);
      } catch {
        /* A window that went away between the event and the query. */
      }
    })();
  });
}

/** Which workspace a terminal tab is showing, or null when it is not one of ours. */
function workspaceOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('terminal.html')) return null;
    return parsed.searchParams.get('workspace');
  } catch {
    return null;
  }
}

/**
 * The last workspace each terminal tab was known to hold.
 *
 * Only for `onRemoved`, which is handed an id and nothing else. Lost when the worker dies, and
 * that is acceptable here in a way it is not for the targets: the cost is a notification for a
 * closed tab surviving until somebody dismisses it, rather than a click that goes nowhere.
 */
const closedTabs = new Map<number, string>();

async function clearForTab(tabId: number, known?: string): Promise<void> {
  let workspaceId = known ?? null;
  if (!workspaceId) {
    try {
      workspaceId = workspaceOf((await chrome.tabs.get(tabId)).url);
    } catch {
      return;
    }
  }
  if (workspaceId) await clearNotificationsFor(workspaceId);
}

/** Focus the tab that already owns a workspace rather than opening a second view of it. */
async function focusWorkspaceTab(workspaceId: string): Promise<void> {
  const base = chrome.runtime.getURL('terminal.html');
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  const hit = tabs.find((t) => t.url?.includes(workspaceId));
  if (hit?.id !== undefined) {
    await chrome.tabs.update(hit.id, { active: true });
    if (hit.windowId !== undefined) await chrome.windows.update(hit.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: `${base}?workspace=${workspaceId}`, active: true });
}
