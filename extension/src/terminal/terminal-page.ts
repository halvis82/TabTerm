import { DaemonClient, type ConnectionStatus } from '../transport/daemon-client.js';
import { getToken } from '../transport/token.js';
import { XtermController } from './xterm-controller.js';
import type { ResolvedPath, ServerMessage, TitleFields } from '@tabterm/shared';
import { createPathLinkProvider, findCandidates } from './path-links.js';
import { applyFavicon, composeTitle, drawFavicon, type FaviconState } from './titles.js';

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
let titleFields: TitleFields = {};
let faviconState: FaviconState = 'disconnected';
let animPhase = 0;
let animTimer: number | undefined;

/**
 * Resolved paths.
 *
 * Cached because the same text is re-examined on every hover and every redraw. Negative
 * results are cached too, so a line full of prose stops being asked about.
 *
 * A RELATIVE path means something different in every directory, so its key includes the
 * working directory it was resolved against. Without that, `src/main.ts` in one project would
 * answer for `src/main.ts` in the next one. Absolute and home-relative paths are keyed on
 * their own, since they do not depend on where the shell happens to be.
 */
const pathCache = new Map<string, ResolvedPath>();
const pathsInFlight = new Set<string>();
let currentCwd = '';

function isCwdIndependent(candidate: string): boolean {
  return candidate.startsWith('/') || candidate.startsWith('~');
}

function cacheKey(candidate: string): string {
  return isCwdIndependent(candidate) ? candidate : `${currentCwd}\u0000${candidate}`;
}

function lookupPath(candidate: string): ResolvedPath | undefined {
  return pathCache.get(cacheKey(candidate));
}

function refreshTitle(status?: string): void {
  document.title = composeTitle(titleFields, status);
}

/**
 * Animation runs only while the tab is visible. A hidden tab has rAF paused and setInterval
 * throttled, so a self-driven spinner would simply stop. State changes still apply when hidden,
 * because they are pushed. See docs/10-limitations.md tier 1.1.
 */
function setFavicon(state: FaviconState): void {
  faviconState = state;
  clearInterval(animTimer);
  animTimer = undefined;
  applyFavicon(drawFavicon(state, animPhase));

  if (state === 'running' && document.visibilityState === 'visible') {
    animTimer = window.setInterval(() => {
      animPhase++;
      applyFavicon(drawFavicon('running', animPhase));
    }, 200);
  }
}

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
      setFavicon('disconnected');
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

  // Printed file and directory paths become clickable once the daemon confirms they exist.
  c.registerLinkProvider(
    createPathLinkProvider(c.term, {
      resolve: (candidates) => {
        const fresh = candidates.filter((x) => !pathsInFlight.has(cacheKey(x)));
        if (fresh.length === 0 || !sessionId) return;
        for (const x of fresh) pathsInFlight.add(cacheKey(x));
        client?.send({ t: 'resolve-paths', sessionId, candidates: fresh });
      },
      lookup: lookupPath,
      activate: (resolved) => {
        if (!sessionId) return;
        // A directory reveals in Finder. A file opens in whatever macOS uses for it.
        client?.send({
          t: 'open-path',
          sessionId,
          path: resolved.candidate,
          how: resolved.isDirectory ? 'reveal-in-finder' : 'default-app',
        });
        setStatus(`Opening ${resolved.absolute}`, 'ok');
        setTimeout(() => setStatus('', 'hidden'), 1600);
      },
      describe: (resolved) => resolved.absolute,
    }),
  );
  return c;
}

function onControl(msg: ServerMessage): void {
  /* eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check --
     Deliberately partial. Later phases add title, cwd, command timing, and agent state
     messages; anything unhandled is ignored so a newer daemon does not break an older page. */
  switch (msg.t) {
    case 'paths-resolved': {
      // Key on the directory the DAEMON resolved against, not on what we thought it was.
      // The daemon asks the OS, so it is authoritative even with no shell integration.
      const keyFor = (candidate: string) =>
        isCwdIndependent(candidate) ? candidate : `${msg.cwd}\u0000${candidate}`;
      if (msg.cwd && msg.cwd !== currentCwd) {
        currentCwd = msg.cwd;
        pathsInFlight.clear();
      }
      for (const r of msg.results) {
        pathCache.set(keyFor(r.candidate), r);
        pathsInFlight.delete(keyFor(r.candidate));
      }
      // A path becomes clickable once the daemon has confirmed it, so refresh what is drawn.
      controller?.refreshLinks();
      return;
    }
    case 'cwd': {
      currentCwd = msg.cwd;
      titleFields = { ...titleFields, cwd: msg.cwd, ...(msg.gitRoot ? { repo: msg.gitRoot } : {}) };
      refreshTitle();
      // A relative path that did not exist in the old directory may exist in this one.
      controller?.refreshLinks();
      return;
    }
    case 'title': {
      titleFields = msg.fields;
      refreshTitle();
      return;
    }
    case 'process-state': {
      setFavicon(msg.state === 'running' ? 'running' : msg.state === 'failed' ? 'failed' : 'idle');
      return;
    }
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
      setFavicon('idle');
      refreshTitle();
      controller?.focus();
      return;
    }
    case 'session-exited': {
      setStatus(`Process exited (${String(msg.exitCode)})`, 'warn');
      setFavicon(msg.exitCode === 0 ? 'idle' : 'failed');
      refreshTitle(`exited ${String(msg.exitCode)}`);
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
  setFavicon('disconnected');
  refreshTitle();

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
    if (document.visibilityState === 'visible') {
      controller?.focus();
      setFavicon(faviconState); // resumes animation if it was suppressed while hidden
    } else {
      clearInterval(animTimer);
      animTimer = undefined;
    }
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
      /** Path candidates found on the visible screen, and what the daemon said about them. */
      probePaths: () => string[];
      resolvedPaths: () => ResolvedPath[];
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
    probePaths: () => {
      const screen = window.__tabterm?.readScreen() ?? '';
      const found = [
        ...new Set(screen.split('\n').flatMap((l) => findCandidates(l).map((c) => c.text))),
      ];
      const unknown = found.filter(
        (x) => !pathCache.has(cacheKey(x)) && !pathsInFlight.has(cacheKey(x)),
      );
      if (unknown.length > 0 && sessionId) {
        for (const x of unknown) pathsInFlight.add(cacheKey(x));
        client?.send({ t: 'resolve-paths', sessionId, candidates: unknown });
      }
      return found;
    },
    resolvedPaths: () => [...pathCache.values()],
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
