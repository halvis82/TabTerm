import { DaemonClient, type ConnectionStatus } from '../transport/daemon-client.js';
import { getToken } from '../transport/token.js';
import { XtermController } from './xterm-controller.js';
import type { ServerMessage } from '@tabterm/shared';

/**
 * A terminal tab.
 *
 * Attaches lazily on first visibility, because Chrome restores every tab at once at startup
 * and eager attaching means N simultaneous snapshot replays competing.
 * See docs/04-session-lifecycle.md §5.
 */
const DEFAULT_PORT = 7377;

const params = new URLSearchParams(location.search);
const requestedSession = params.get('session');

const root = document.getElementById('terminal') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const recoveryEl = document.getElementById('recovery') as HTMLElement;

let client: DaemonClient | null = null;
let controller: XtermController | null = null;
let streamId = 0;
let sessionId = requestedSession ?? '';
let attached = false;

function setStatus(text: string, tone: 'ok' | 'warn' | 'error' | 'hidden'): void {
  statusEl.textContent = text;
  statusEl.dataset['tone'] = tone;
  statusEl.hidden = tone === 'hidden';
}

function statusFor(s: ConnectionStatus): void {
  switch (s) {
    case 'connecting':
    case 'authenticating':
      setStatus('Connecting to tabtermd', 'warn');
      return;
    case 'ready':
      setStatus('', 'hidden');
      return;
    case 'retrying':
      setStatus('tabtermd is not responding. Retrying', 'error');
      return;
    case 'closed':
      setStatus('Disconnected', 'error');
      return;
  }
}

function showRecovery(reason: string): void {
  recoveryEl.hidden = false;
  root.style.display = 'none';
  (document.getElementById('recovery-reason') as HTMLElement).textContent = reason;
}

function buildTerminal(): XtermController {
  const c = new XtermController({
    container: root,
    onData: (data) => client?.write(streamId, new TextEncoder().encode(data)),
    onResize: (cols, rows) => {
      if (sessionId) client?.send({ t: 'resize', sessionId, cols, rows });
    },
    onLinkClick: (uri) => {
      // Scheme allowlist. Everything else stays inert text. See docs/05-security.md §4.
      if (/^https?:\/\//i.test(uri) || /^mailto:/i.test(uri)) {
        void chrome.tabs.create({ url: uri });
      }
    },
  });
  return c;
}

function onControl(msg: ServerMessage): void {
  /* eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check --
     Deliberately partial. Later phases add title, cwd, command timing, and agent state
     messages; anything unhandled is ignored so a newer daemon does not break an older page. */
  switch (msg.t) {
    case 'auth-ok': {
      const { cols, rows } = controller?.fit() ?? { cols: 80, rows: 24 };
      if (sessionId) {
        client?.send({ t: 'attach', sessionId, cols, rows });
      } else {
        client?.send({ t: 'create-session', cols, rows });
      }
      return;
    }
    case 'session-created': {
      sessionId = msg.sessionId;
      streamId = msg.streamId;
      // Put the id in the URL so Chrome's own restore brings us back to this exact session.
      const url = new URL(location.href);
      url.searchParams.set('session', sessionId);
      history.replaceState(null, '', url.toString());
      return;
    }
    case 'snapshot': {
      streamId = msg.snapshot.streamId;
      sessionId = msg.snapshot.sessionId;
      // Restore is a full repaint from daemon state, so any prior contents are discarded.
      controller?.reset();
      controller?.write(new TextEncoder().encode(msg.snapshot.screen), () => {});
      attached = true;
      controller?.focus();
      return;
    }
    case 'session-exited': {
      setStatus(`Process exited (${String(msg.exitCode)})`, 'warn');
      return;
    }
    case 'error': {
      if (msg.code === 'session-expired' || msg.code === 'session-not-found') {
        showRecovery('This terminal session expired.');
      } else {
        setStatus(msg.message, 'error');
      }
      return;
    }
    default:
      return;
  }
}

async function start(): Promise<void> {
  const token = await getToken();
  if (!token) {
    showRecovery('TabTerm is not paired with the daemon yet.');
    return;
  }

  controller = buildTerminal();
  installTestHook();

  client = new DaemonClient({
    port: DEFAULT_PORT,
    token,
    clientId: await stableClientId(),
    role: 'data',
    onControl,
    onOutput: (id, data) => {
      if (id !== streamId) return;
      controller?.write(data, (bytes) => client?.ack(id, bytes));
    },
    onStatus: statusFor,
  });
  client.connect();

  const resize = () => {
    const size = controller?.fit();
    if (size && sessionId && attached) {
      client?.send({ t: 'resize', sessionId, cols: size.cols, rows: size.rows });
    }
  };
  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    // Dragging a window edge must not produce a SIGWINCH storm.
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 80);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') controller?.focus();
  });
}

/**
 * Testing surface.
 *
 * The WebGL renderer draws to a canvas, so the terminal's text is not in the DOM and cannot be
 * read by an automated check. This exposes the buffer instead. It reveals nothing the page does
 * not already hold, and extension pages cannot be scripted from outside the extension.
 */
declare global {
  interface Window {
    __tabterm?: {
      readScreen: () => string;
      sessionId: () => string;
      attached: () => boolean;
    };
  }
}

function installTestHook(): void {
  window.__tabterm = {
    readScreen: () => {
      const term = controller?.term;
      if (!term) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    sessionId: () => sessionId,
    attached: () => attached,
  };
}

async function stableClientId(): Promise<string> {
  const KEY = 'tabterm.clientId';
  const got = await chrome.storage.local.get(KEY);
  const existing = got[KEY] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY]: id });
  return id;
}

// Lazy attach: do nothing until the tab is actually looked at.
if (document.visibilityState === 'visible') {
  void start();
} else {
  setStatus('Suspended. Activate this tab to reconnect.', 'warn');
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'visible') void start();
    },
    { once: true },
  );
}
