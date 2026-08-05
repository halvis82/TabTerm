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

/** Click targets, kept so a click focuses the right tab rather than guessing. */
const targets = new Map<string, { workspaceId?: string; paneId?: string }>();

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

  const id = `tabterm:${String(Date.now())}:${Math.random().toString(36).slice(2, 8)}`;
  if (req.target) targets.set(id, req.target);

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
          requireInteraction: req.priority === 'critical',
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
    targets.delete(id);
    return null;
  }
  return id;
}

export function installClickHandler(): void {
  chrome.notifications.onClicked.addListener((id) => {
    const target = targets.get(id);
    targets.delete(id);
    void chrome.notifications.clear(id);
    if (!target?.workspaceId) return;
    void focusWorkspaceTab(target.workspaceId);
  });

  chrome.notifications.onClosed.addListener((id) => targets.delete(id));
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
