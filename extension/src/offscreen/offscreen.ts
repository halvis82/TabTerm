import { DaemonClient } from '../transport/daemon-client.js';

/**
 * Offscreen document: the control connection.
 *
 * One per Chrome profile. This exists because the service worker dies at idle (measured at
 * roughly 40 seconds) and terminal tabs get discarded, so neither can hold a connection that
 * must always be there. See ADR-0003.
 *
 * Measured constraint: an offscreen document is given ONLY `chrome.runtime`. There is no
 * `chrome.storage` and no `chrome.runtime.sendNativeMessage` here, so it cannot fetch the
 * daemon token itself. It asks the service worker, which has the full API surface. Sending a
 * message also wakes the worker if it has already died.
 *
 * **The port comes the same way, for the same reason.** It used to call `daemonPort()`, which
 * reads `chrome.storage` and therefore threw in here every time and fell back to the default.
 * So this connection went to port 7377 whatever the installation was configured for, and under
 * the browser suites it meant notifications, tab reports and session lists all came from the
 * daemon somebody was working in rather than the one the run had started. A fallback that is
 * always taken is not a fallback.
 */

let client: DaemonClient | null = null;
/** What the current connection was made with, so different credentials can be recognised. */
let using: { token: string; port: number } | null = null;

/**
 * Connect, or reconnect when the credentials have changed.
 *
 * Returning early whenever a connection existed was right for the ordinary case and wrong for the
 * one that matters: a token that has been replaced. The connection then goes on failing
 * authentication forever against a daemon that will never accept it, and nothing retries with
 * the new one because nothing noticed it arrived.
 *
 * That is not hypothetical. The browser suites point a fresh browser at their own daemon by
 * writing its token, and the extension can ask the installed native host for one first: the
 * document connected with the wrong token and stayed wrong for the whole run, which read as the
 * harness being unreliable.
 */
function start(token: string, clientId: string, port: number): void {
  if (client && using && using.token === token && using.port === port) return;
  if (client) {
    client.close();
    client = null;
  }
  using = { token, port };
  startOn(port, token, clientId);
}

function startOn(port: number, token: string, clientId: string): void {
  if (client) return;
  client = new DaemonClient({
    port,
    token,
    clientId: `${clientId}:control`,
    role: 'control',
    onControl: (msg) => {
      // Anything that must reach the user while every terminal tab is hidden or discarded
      // originates here, because this is the only context that survives both.
      if (msg.t === 'notify') {
        // Measured: an offscreen document is given ONLY chrome.runtime. It has no
        // chrome.notifications, so it relays to the service worker, which has the full API
        // surface. Sending the message also wakes the worker, which by now has died.
        // See docs/06-chrome-integration.md §2.
        void chrome.runtime
          .sendMessage({
            t: 'tabterm:notify',
            priority: msg.priority,
            title: msg.title,
            body: msg.body,
            target: msg.target,
            suppressIfVisible: msg.suppressIfVisible,
          })
          .catch(() => {
            /* the worker may be mid-restart; a dropped notification is not worth retrying */
          });
      }
      /**
       * The installer asking the extension to reload itself.
       *
       * Relayed to the worker rather than done here, because `chrome.runtime.reload` ends this
       * document along with everything else and the worker is the context that owns the
       * extension's lifetime. It also has the code that puts the tabs back afterwards.
       */
      if (msg.t === 'reload-extension') {
        void chrome.runtime.sendMessage({ t: 'tabterm:reload-extension' }).catch(() => {
          /* If the worker cannot be reached, the reload simply does not happen. */
        });
      }
    },
    onOutput: () => {
      /* The control connection carries no terminal output. */
    },
    onStatus: () => {
      /* Reconnect is handled inside the client, with backoff. */
    },
    /**
     * Refused credentials are asked for again rather than offered a second time.
     *
     * A token can genuinely change: a daemon reinstalled, or a state directory cleared. Before
     * this the connection retried with the rejected token on its own schedule and the extension
     * stayed broken until the browser was restarted.
     */
    onAuthRefused: () => {
      using = null;
      void chrome.runtime.sendMessage({ t: 'tabterm:token-refused' }).catch(() => undefined);
      setTimeout(() => void requestCredentials(), 1500);
    },
  });
  client.connect();
}

interface Credentials {
  token?: string;
  clientId?: string;
  /** Read by the worker, which has `chrome.storage`, because this document does not. */
  port?: number;
}

async function requestCredentials(): Promise<void> {
  try {
    const reply: Credentials | undefined = await chrome.runtime.sendMessage({
      t: 'tabterm:need-credentials',
    });
    if (reply?.token && reply.clientId && reply.port) {
      start(reply.token, reply.clientId, reply.port);
    }
  } catch {
    // The worker may be starting up. Retry rather than give up: this document is long lived
    // and the worker is not.
    setTimeout(() => void requestCredentials(), 2000);
  }
}

// The worker may also push credentials unprompted, right after creating this document.
chrome.runtime.onMessage.addListener(
  (
    msg: { t?: string; workspaceIds?: readonly string[] } & Credentials,
    _sender,
    sendResponse: (reply: { sent: boolean }) => void,
  ) => {
    if (msg.t === 'tabterm:credentials' && msg.token && msg.clientId && msg.port) {
      start(msg.token, msg.clientId, msg.port);
    }
    /**
     * What Chrome has open, forwarded to the daemon.
     *
     * The service worker can see tabs and cannot hold a connection; this document holds the
     * connection and cannot see tabs. So the answer travels through here. Without it the daemon
     * has only the state of a socket to go on, and a socket is not a tab: a session was once
     * ended seventeen hours after its last command while its tab was sitting there.
     */
    if (msg.t === 'tabterm:tabs-open' && Array.isArray(msg.workspaceIds)) {
      /**
       * Answered with whether it went anywhere, so the worker knows to try again.
       *
       * This document exists before it is connected, so a report arriving in that window used to
       * be dropped by the `?.` and reported as delivered by the absence of an exception. The
       * worker's next attempt was two minutes away, and a terminal can be ended in thirty
       * seconds.
       */
      const connected = client?.connected === true;
      if (connected) client?.send({ t: 'tabs-open', workspaceIds: msg.workspaceIds });
      sendResponse({ sent: connected });
      return false;
    }
    return false;
  },
);

void requestCredentials();
