import { getToken } from './transport/token.js';

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

async function openTerminal(): Promise<void> {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const created = await chrome.tabs.create({
    url: chrome.runtime.getURL('terminal.html'),
    index: current ? current.index + 1 : undefined,
    active: true,
  });
  // Inherit the current tab's group, so a terminal lands beside the work it belongs to.
  if (current?.groupId !== undefined && current.groupId > -1 && created.id !== undefined) {
    try {
      await chrome.tabs.group({ groupId: current.groupId, tabIds: [created.id] });
    } catch {
      /* the group may have closed between the query and here */
    }
  }
  void ensureOffscreen();
  void reportShortcuts();
}

chrome.runtime.onMessage.addListener((msg: { t?: string }, _sender, sendResponse) => {
  if (msg.t !== 'tabterm:need-credentials') return false;
  void (async () => {
    sendResponse({ token: await getToken(), clientId: await clientId() });
  })();
  return true; // keep the channel open for the async reply
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen();
  void reportShortcuts();
});
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

void ensureOffscreen();
