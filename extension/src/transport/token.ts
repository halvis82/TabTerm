/**
 * The daemon writes its token to a 0600 file, which an extension cannot read. A native
 * messaging host bridges that gap, and Chrome enforces its allowed_origins list, so the host
 * also authenticates the extension in a way the socket alone cannot.
 * See docs/05-security.md §3.
 *
 * The token is held in session storage only. Never in local storage, never logged.
 */
const HOST = 'com.tabterm.host';
const KEY = 'tabterm.token';

export async function getToken(): Promise<string | null> {
  const cached = await chrome.storage.session.get(KEY);
  const hit = cached[KEY] as string | undefined;
  if (typeof hit === 'string' && hit.length === 64) return hit;

  try {
    const reply = (await chrome.runtime.sendNativeMessage(HOST, { t: 'get-token' })) as {
      token?: string;
    };
    if (typeof reply.token === 'string' && reply.token.length === 64) {
      await chrome.storage.session.set({ [KEY]: reply.token });
      return reply.token;
    }
  } catch {
    /* Host not installed. Fall through to the manual pairing path. */
  }

  // Fallback: a code pasted into the options page once. This must work, because it is the
  // recovery path when the native host breaks.
  const manual = await chrome.storage.local.get('tabterm.pairedToken');
  const paired = manual['tabterm.pairedToken'] as string | undefined;
  if (typeof paired === 'string' && paired.length === 64) {
    await chrome.storage.session.set({ [KEY]: paired });
    return paired;
  }
  return null;
}

export async function clearToken(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
