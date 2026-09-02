/**
 * Which daemon to talk to.
 *
 * Always 7377 in normal use. The override exists so the browser suites can run against a daemon
 * of their own rather than the one somebody is working in.
 *
 * That is not a convenience. Sharing a daemon with a person and being careful is not a safe
 * arrangement: a sweep in the test harness once ended a real terminal nineteen seconds after it
 * had been used, because nothing on a start screen distinguishes a session a suite created from
 * one somebody is using. Not sharing a daemon removes the question.
 */
export const DEFAULT_PORT = 7377;

const KEY = 'tabterm.port';

export async function daemonPort(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const port = Number(stored[KEY]);
    // A stored value has to be a real port, or the product silently fails to connect at all.
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    /* Storage unavailable is not a reason to fail to start; the default is right anyway. */
  }
  return DEFAULT_PORT;
}
