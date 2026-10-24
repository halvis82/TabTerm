/**
 * A new tab at the end of the window that closes back to where it was opened from.
 *
 * Asked for: "if you have 5 tabs open and you're on tab 3 and you open a new tab with cmd t that
 * is opened as tab 6 ... and then if you close it, you don't go to tab 5, you go back to tab 3.
 * can we make that the same behavior with tabterm". Chrome does that for Cmd+T by remembering
 * which tab a new one was opened from, and forgets it as soon as somebody switches tabs by hand.
 * A tab created without an opener has none, so closing it fell through to its neighbour, which at
 * the end of the strip is whatever tab happened to be last.
 *
 * Naming the tab in front as the opener hands the same rule to Chrome, including the forgetting.
 * Only within one window: an opener in another window means nothing to the strip it lands in.
 */
export async function openTabAtEnd(url: string): Promise<chrome.tabs.Tab> {
  const [from] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return chrome.tabs.create({
    url,
    active: true,
    ...(from?.id === undefined ? {} : { openerTabId: from.id, windowId: from.windowId }),
  });
}
