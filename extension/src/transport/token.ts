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
    /*
     * Host not installed, which is the one thing a page cannot fix for itself. The caller shows
     * the onboarding screen, and the recovery is to run the installer again.
     */
  }

  /*
   * There is no manual pairing fallback, and there used to be half of one.
   *
   * A read of `tabterm.pairedToken` out of `chrome.storage.local` sat here, against a documented
   * `tabterm pair` command and an extension options page. Neither was ever built: nothing in this
   * repository writes that key and the manifest has no options page, so the read could only ever
   * return nothing.
   *
   * It is removed rather than left harmless because of where it read from. Local storage is
   * exactly where this token may never be, by the rule four lines up and in docs/05-security.md,
   * and a path that would have accepted one from there is worth deleting before somebody
   * implements the other half and makes it real.
   */
  return null;
}

export async function clearToken(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
