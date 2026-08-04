import { VERSION } from '@tabterm/shared';

/**
 * Service worker: dispatch only.
 *
 * MV3 terminates this after roughly 30 seconds idle, so it holds no connection and no state.
 * It wakes for a command or a context menu, forwards to the offscreen document, and dies.
 * See docs/06-chrome-integration.md.
 */
chrome.runtime.onInstalled.addListener(() => {
  console.warn(`TabTerm ${VERSION} installed`);
});
