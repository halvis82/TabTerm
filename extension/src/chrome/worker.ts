/**
 * Messages from a page to the service worker, which may not be there to hear them.
 *
 * Chrome's worker for an extension stops whenever it has been idle, and in the worst case it is
 * gone until the extension is reloaded. A message sent to it then rejects with Chrome's own
 * "No SW", and a page that did not catch that left "Uncaught (in promise) Error: No SW" on
 * chrome://extensions for every message it had fired and forgotten. Reported as wanting that
 * page clean. Nothing here is a message whose loss matters more than the worker's absence
 * already does: a tab that could not be counted, a port that could not be opened, a reload
 * that could not be relayed. So they are sent and let go.
 */

/** Send and forget. A worker that is not running is not an error the page can act on. */
export function tellWorker(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    /* the worker is asleep or gone, and the message was best effort */
  });
}

/** Send and wait for an answer, or get nothing back when the worker is not running. */
export async function askWorker<T>(message: unknown): Promise<T | undefined> {
  try {
    const reply: T | undefined = await chrome.runtime.sendMessage(message);
    return reply;
  } catch {
    return undefined;
  }
}
