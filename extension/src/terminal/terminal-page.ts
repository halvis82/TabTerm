import type {
  LayoutNode,
  MergeableSession,
  ResolvedPath,
  ResumableAgentSession,
  SavedItem,
  ServerMessage,
  TitleFields,
} from '@tabterm/shared';
import { DaemonClient, type ConnectionStatus } from '../transport/daemon-client.js';
import { getToken } from '../transport/token.js';
import { SplitView, collectPanes } from '../layout/split-view.js';
import { PaneHost } from './panes.js';
import { findCandidates } from './path-links.js';
import { chooseOpenAction, describeOpen } from './open-action.js';
import { PaneStatus } from './pane-status.js';
import { describeTime, isLongRunning, type TimeState } from './elapsed.js';
import { applyFavicon, composeTitle, drawFavicon, type FaviconState } from './titles.js';
import { Launcher } from '../launcher/launcher.js';
import { Palette } from '../launcher/palette.js';

/**
 * A terminal tab, which is really a workspace of one or more panes.
 *
 * A standalone terminal is a workspace with a single pane, so splitting is not a mode switch:
 * the same code path renders one pane or six. See docs/03-data-model.md §2.
 *
 * Attaching is deferred until the tab is actually looked at, because Chrome restores every tab
 * at once at startup and eager attach means N snapshot replays competing.
 * See docs/04-session-lifecycle.md §5.
 */
const DEFAULT_PORT = 7377;

const params = new URLSearchParams(location.search);

const root = document.getElementById('terminal') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const recoveryEl = document.getElementById('recovery') as HTMLElement;

let client: DaemonClient | null = null;
let panesHost: PaneHost | null = null;
let splitView: SplitView | null = null;
let launcher: Launcher | null = null;
let palette: Palette | null = null;
let savedItems: SavedItem[] = [];
let mergeable: MergeableSession[] = [];

let workspaceId = params.get('workspace') ?? '';
let layout: LayoutNode | null = null;
let attached = false;

let titleFields: TitleFields = {};
let faviconState: FaviconState = 'disconnected';
/** A tab has one favicon, so many panes reduce to the most urgent state among them. */
const paneStatus = new PaneStatus();

/**
 * Per-pane timing, driven entirely by discrete events from the daemon.
 *
 * The label is recomputed locally at 1 Hz while visible and not at all while hidden, because a
 * hidden tab throttles timers anyway and nobody is reading it. See docs/11-performance.md §6.
 */
const paneTime = new Map<string, TimeState>();
let timeTimer: number | undefined;

function timeStateFor(paneId: string): TimeState {
  let state = paneTime.get(paneId);
  if (!state) {
    state = {};
    paneTime.set(paneId, state);
  }
  return state;
}

function renderTimeLabels(): void {
  for (const pane of panesHost?.all ?? []) {
    const text = describeTime(timeStateFor(pane.paneId));
    const wrapper = pane.element.parentElement;
    if (!wrapper) continue;
    let label = wrapper.querySelector('.pane-time');
    if (!text) {
      label?.remove();
      continue;
    }
    if (!label) {
      label = document.createElement('div');
      label.className = 'pane-time';
      wrapper.append(label);
    }
    label.textContent = text;
  }
}

function startTimeTicking(): void {
  clearInterval(timeTimer);
  timeTimer = undefined;
  renderTimeLabels();
  if (document.visibilityState !== 'visible') return;
  // Once per second is the fastest a human reads a duration, and no faster than the display
  // can meaningfully change.
  timeTimer = window.setInterval(renderTimeLabels, 1000);
}

function stopTimeTicking(): void {
  clearInterval(timeTimer);
  timeTimer = undefined;
}
let animPhase = 0;
let animTimer: number | undefined;

/**
 * Resolved paths.
 *
 * A RELATIVE path means something different in every directory, so its key includes the
 * directory it was resolved against. Absolute and home-relative paths stand on their own.
 */
const pathCache = new Map<string, ResolvedPath>();
const pathsInFlight = new Set<string>();
let currentCwd = '';

/** Links are inert unless Command is held, so ordinary text selection stays safe. */
let cmdHeld = false;

// ---------------------------------------------------------------------------
// Chrome-facing surface
// ---------------------------------------------------------------------------

function setStatus(text: string, tone: 'ok' | 'warn' | 'error' | 'hidden'): void {
  statusEl.textContent = text;
  statusEl.dataset['tone'] = tone;
  statusEl.hidden = tone === 'hidden';
}

function refreshTitle(status?: string): void {
  const count = layout ? collectPanes(layout).length : 1;
  // With several panes the interesting thing is what needs attention, not the pane count.
  const attention =
    paneStatus.countIn('approval') > 0
      ? 'needs approval'
      : paneStatus.countIn('failed') > 0
        ? 'failed'
        : paneStatus.countIn('running') > 0 && count > 1
          ? `${String(paneStatus.countIn('running'))} running`
          : count > 1
            ? `${String(count)} panes`
            : '';
  document.title = composeTitle(titleFields, status ?? attention);
}

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

/**
 * What a tab shows when its session is gone.
 *
 * Chrome offers no way to remove one entry from its recently-closed stack, so restoring the URL
 * of an expired session is normal rather than exceptional. It has to be a useful screen, and
 * nothing on it ever runs by itself. See docs/04-session-lifecycle.md §8.
 */
/**
 * Confirm text that came from a webpage before it reaches the shell.
 *
 * The whole point of the overlay is that the user reads the exact string. It is rendered with
 * textContent into a `pre`, never as markup, and the accept path sends it **without a trailing
 * newline**, so it lands at the prompt and waits. See docs/05-security.md §4.
 */
function showStaged(text: string, source: string): void {
  const panel = document.getElementById('staged') as HTMLElement;
  (document.getElementById('staged-text') as HTMLElement).textContent = text;
  (document.getElementById('staged-source') as HTMLElement).textContent = `From ${source}`;
  panel.hidden = false;

  const dismiss = () => {
    panel.hidden = true;
    // Take the parameters out of the URL, so a reload or a Chrome restore does not re-ask
    // about something the user already answered.
    const url = new URL(location.href);
    url.searchParams.delete('staged');
    url.searchParams.delete('stagedFrom');
    history.replaceState(null, '', url.toString());
    if (splitView?.focused) panesHost?.focus(splitView.focused);
  };

  (document.getElementById('staged-accept') as HTMLElement).onclick = () => {
    // No newline. This is the difference between staging and running.
    sendToFocusedPane(text);
    dismiss();
  };
  (document.getElementById('staged-cancel') as HTMLElement).onclick = dismiss;
}

/**
 * Offer to open a server the terminal just noticed.
 *
 * An offer rather than an action: opening a tab because a process bound a port would be a
 * browser doing something nobody asked for. It fades out on its own, because a dev server
 * restart should not leave a queue of notices behind.
 */
function showServerOffer(port: number): void {
  const bar = document.getElementById('server-offer') as HTMLElement;
  const open = document.getElementById('server-open') as HTMLButtonElement;
  (document.getElementById('server-text') as HTMLElement).textContent =
    `Listening on port ${String(port)}`;
  open.textContent = `Open localhost:${String(port)}`;
  open.onclick = () => {
    void chrome.runtime.sendMessage({ t: 'tabterm:open-local', port });
    bar.hidden = true;
  };
  (document.getElementById('server-dismiss') as HTMLElement).onclick = () => {
    bar.hidden = true;
  };
  bar.hidden = false;
  clearTimeout(serverOfferTimer);
  serverOfferTimer = setTimeout(() => {
    bar.hidden = true;
  }, 20_000);
}
let serverOfferTimer: ReturnType<typeof setTimeout> | undefined;

function showRecovery(reason: string): void {
  recoveryEl.hidden = false;
  root.style.display = 'none';
  (document.getElementById('recovery-reason') as HTMLElement).textContent = reason;
  // Ask what we can remember about it, so the offer can be specific.
  if (workspaceId) client?.send({ t: 'recall-workspace', workspaceId });
  client?.send({ t: 'list-resumable', limit: 8 });
}

function renderRecoveryActions(recall: {
  found: boolean;
  cwd?: string;
  lastCommand?: string;
  lastSeenAt?: number;
}): void {
  const detail = document.getElementById('recovery-detail') as HTMLElement;
  const actions = document.getElementById('recovery-actions') as HTMLElement;
  detail.replaceChildren();
  actions.replaceChildren();

  if (recall.found && recall.cwd) {
    const rows: [string, string][] = [['Last directory', recall.cwd]];
    if (recall.lastCommand) rows.push(['Last command', recall.lastCommand]);
    if (recall.lastSeenAt) rows.push(['Ended', relativeTime(recall.lastSeenAt)]);
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'recovery-row';
      const k = document.createElement('span');
      k.className = 'recovery-key';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'recovery-value';
      v.textContent = value;
      row.append(k, v);
      detail.append(row);
    }
  }

  const button = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.className = 'launcher-chip';
    b.textContent = label;
    b.addEventListener('click', onClick);
    actions.append(b);
  };

  if (recall.found && recall.cwd) {
    const cwd = recall.cwd;
    button('Start a shell here again', () => startFresh(cwd));

    // If an agent was working here, picking that conversation back up is usually what someone
    // wants after an expiry. Offered, never done automatically.
    const resumable = resumableSessions.find((r) => r.cwd === cwd);
    if (resumable) {
      button(`Resume the agent session here`, () => {
        recoveryEl.hidden = true;
        root.style.display = '';
        client?.send({
          t: 'resume-agent',
          sessionId: resumable.sessionId,
          cwd,
          cols: 80,
          rows: 24,
        });
      });
    }
  }
  button('Start a shell in home', () => startFresh(undefined));
  button('Close tab', () => window.close());
}

/** What the daemon last reported as resumable, so the recovery page can offer it too. */
let resumableSessions: readonly ResumableAgentSession[] = [];

/** A new session, never an automatic one. The user asked for this by clicking. */
function startFresh(cwd: string | undefined): void {
  workspaceId = '';
  const url = new URL(location.href);
  url.searchParams.delete('workspace');
  history.replaceState(null, '', url.toString());
  recoveryEl.hidden = true;
  root.style.display = '';
  client?.send({ t: 'create-session', cols: 80, rows: 24, ...(cwd ? { cwd } : {}) });
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isCwdIndependent(candidate: string): boolean {
  return candidate.startsWith('/') || candidate.startsWith('~');
}
function cacheKey(candidate: string, cwd = currentCwd): string {
  return isCwdIndependent(candidate) ? candidate : `${cwd}\u0000${candidate}`;
}
function lookupPath(candidate: string): ResolvedPath | undefined {
  return pathCache.get(cacheKey(candidate));
}

// ---------------------------------------------------------------------------
// Modifier tracking
// ---------------------------------------------------------------------------

function setCmdHeld(held: boolean): void {
  if (held === cmdHeld) return;
  cmdHeld = held;
  document.body.classList.toggle('cmd-held', held);
  panesHost?.refreshLinks();
}

function installModifierTracking(): void {
  window.addEventListener('keydown', (e) => setCmdHeld(e.metaKey), { capture: true });
  window.addEventListener('keyup', (e) => setCmdHeld(e.metaKey), { capture: true });
  window.addEventListener('mousemove', (e) => setCmdHeld(e.metaKey));
  window.addEventListener('blur', () => setCmdHeld(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') setCmdHeld(false);
  });
}

// ---------------------------------------------------------------------------
// Panes and layout
// ---------------------------------------------------------------------------

function buildHosts(): void {
  panesHost = new PaneHost({
    onData: (paneId, data) => {
      const pane = panesHost?.get(paneId);
      if (!pane) return;
      // Anything reaching the shell means the user has started working, so the panel goes.
      launcher?.dismiss();
      client?.write(pane.streamId, new TextEncoder().encode(data));
    },
    onResize: (paneId, cols, rows) => {
      if (workspaceId) client?.send({ t: 'resize-pane', workspaceId, paneId, cols, rows });
    },
    resolvePaths: (paneId, candidates) => {
      const pane = panesHost?.get(paneId);
      if (!pane) return;
      const fresh = candidates.filter((x) => !pathsInFlight.has(cacheKey(x)));
      if (fresh.length === 0) return;
      for (const x of fresh) pathsInFlight.add(cacheKey(x));
      client?.send({ t: 'resolve-paths', sessionId: pane.sessionId, candidates: fresh });
    },
    lookupPath,
    openPath: (paneId, resolved, event) => {
      const pane = panesHost?.get(paneId);
      if (!pane) return;
      const how = chooseOpenAction(resolved, event);
      client?.send({ t: 'open-path', sessionId: pane.sessionId, path: resolved.candidate, how });
      setStatus(`${describeOpen(how)} ${resolved.absolute}`, 'ok');
      setTimeout(() => setStatus('', 'hidden'), 1600);
    },
    openUrl: (url) => {
      // Scheme allowlist. Anything else stays inert text. See docs/05-security.md §4.
      if (/^https?:\/\//i.test(url)) void chrome.tabs.create({ url });
    },
    modifierHeld: () => cmdHeld,
  });

  splitView = new SplitView({
    root,
    paneElement: (paneId, sessionId) => panesHost?.element(paneId, sessionId) as HTMLElement,
    onRatioChange: (paneId, ratio) => {
      if (workspaceId) client?.send({ t: 'set-ratio', workspaceId, paneId, ratio });
    },
    onFocusPane: (paneId) => panesHost?.focus(paneId),
    onPaneResized: (paneId) => {
      const size = panesHost?.fit(paneId);
      if (size && workspaceId && attached) {
        client?.send({ t: 'resize-pane', workspaceId, paneId, cols: size.cols, rows: size.rows });
      }
    },
  });
}

function buildLauncher(): void {
  const overlay = document.getElementById('overlays') as HTMLElement;

  launcher = new Launcher({
    root: overlay,
    onChooseDir: (path) => {
      // Send a real `cd` rather than restarting the session: the shell you are already in is
      // the one you want, just somewhere else.
      sendToFocusedPane(`cd ${quote(path)}\r`);
      launcher?.dismiss();
    },
    onCreateLayout: (path, panesWanted, direction) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({
        t: 'create-layout',
        path,
        panes: panesWanted,
        direction,
        createIfMissing: true,
        ...size,
      });
      launcher?.dismiss();
    },
    onLaunchAgent: (path) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({ t: 'launch-agent', where: 'new-tab', cwd: path, ...size });
      launcher?.dismiss();
    },
    onPinDir: (path, pinned) => {
      client?.send({ t: 'pin-dir', path, pinned });
      client?.send({ t: 'list-launcher' });
    },
    onForgetDir: (path) => {
      client?.send({ t: 'forget-dir', path });
      client?.send({ t: 'list-launcher' });
    },
    onInspectProject: (path) => client?.send({ t: 'inspect-project', cwd: path }),
    onDecideProjectTrust: (info, decision) => {
      client?.send({
        t: 'decide-project-trust',
        path: info.path,
        contentHash: info.contentHash,
        decision,
      });
      // Re-read rather than assume: the daemon is the authority on what the decision means,
      // and the file may have changed between the prompt and the click.
      client?.send({ t: 'inspect-project', cwd: info.path.replace(/\/[^/]+$/, '') });
    },
    onOpenServer: (port) => {
      void chrome.runtime.sendMessage({ t: 'tabterm:open-local', port });
    },
    onAttachServer: (server) => {
      // Focus the tab that owns the workspace rather than opening a second view of it.
      if (server.workspaceId && server.workspaceId === workspaceId) {
        launcher?.dismiss();
        return;
      }
      const url = chrome.runtime.getURL(
        server.workspaceId ? `terminal.html?workspace=${server.workspaceId}` : 'terminal.html',
      );
      void chrome.tabs.create({ url, active: true });
    },
    onStopServer: (server, restart) => {
      client?.send({ t: 'stop-server', sessionId: server.sessionId, restart });
      // Ask again shortly, so the row disappears once it has actually stopped rather than
      // sitting there claiming a server that is gone.
      setTimeout(() => client?.send({ t: 'list-servers' }), 2500);
    },
    onResumeAgent: (session) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({
        t: 'resume-agent',
        sessionId: session.sessionId,
        cwd: session.cwd,
        ...size,
      });
      launcher?.dismiss();
    },
    onOpenProject: (path) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({ t: 'launch-project-template', cwd: path, ...size });
      launcher?.dismiss();
    },
    onDismiss: () => panesHost?.focus(splitView?.focused ?? ''),
  });

  palette = new Palette({
    root: overlay,
    onQuery: (query, scope, offset) => {
      const sessionId = focusedSessionId();
      client?.send({
        t: 'list-history',
        query,
        scope,
        offset,
        limit: 100,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onPaste: (text) => sendToFocusedPane(text),
    // A separate callback from paste, so running is never something the paste path can do.
    onRun: (text) => sendToFocusedPane(`${text}\r`),
    onOpenDir: (path) => sendToFocusedPane(`cd ${quote(path)}\r`),
    onCopy: (text) => void navigator.clipboard.writeText(text),
    onSave: (text) => client?.send({ t: 'save-item', title: text.slice(0, 60), body: text }),
    onSaveScoped: (text, scopeToProject) => {
      const sessionId = focusedSessionId();
      client?.send({
        t: 'save-item',
        title: text.slice(0, 60),
        body: text,
        scopeToProject,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onPinSaved: (id, pinned) => client?.send({ t: 'pin-saved', id, pinned }),
    onUseSaved: (id) => client?.send({ t: 'use-saved', id }),
    onDeleteSaved: (id) => client?.send({ t: 'delete-saved', id }),
    onMerge: (sessionId) => {
      const targetPaneId = splitView?.focused;
      if (!targetPaneId || !workspaceId) return;
      client?.send({
        t: 'merge-into',
        workspaceId,
        targetPaneId,
        sessionId,
        direction: 'horizontal',
      });
    },
    onClose: () => panesHost?.focus(splitView?.focused ?? ''),
  });
}

/** Shell-quote a path so a folder with a space or a quote in it still works. */
function quote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The session behind the focused pane, which is what a scoped search resolves against. */
function focusedSessionId(): string | undefined {
  const paneId = splitView?.focused;
  const pane = paneId ? panesHost?.get(paneId) : undefined;
  return pane?.sessionId;
}

function sendToFocusedPane(text: string): void {
  const paneId = splitView?.focused;
  const pane = paneId ? panesHost?.get(paneId) : undefined;
  if (!pane) return;
  client?.write(pane.streamId, new TextEncoder().encode(text));
  launcher?.dismiss();
}

function applyLayout(next: LayoutNode): void {
  layout = next;
  splitView?.render(next);
  const live = collectPanes(next);
  panesHost?.retain(live);
  // A pane that no longer exists must stop influencing the tab's indicator.
  paneStatus.retain(live);
  for (const id of [...paneTime.keys()]) if (!live.includes(id)) paneTime.delete(id);
  setFavicon(paneStatus.effective());
  refreshTitle();
}

function splitFocused(direction: 'horizontal' | 'vertical'): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  const size = panesHost?.fit(paneId) ?? { cols: 80, rows: 24 };
  client?.send({ t: 'split-pane', workspaceId, paneId, direction, ...size });
}

/**
 * Pull the focused pane out into its own tab.
 *
 * The PTY is untouched throughout: only the layout changes and a new tab picks the session up
 * at its own workspace URL. See docs/04-session-lifecycle.md §6.
 */
function detachFocused(): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  if (layout && collectPanes(layout).length <= 1) return;
  client?.send({ t: 'detach-pane-to-tab', workspaceId, paneId });
}

/**
 * Launch an agent CLI in the current directory.
 *
 * A new native tab is the default, because that is the premise of the product: an agent
 * session is a Chrome tab like any other. A split is the secondary action.
 * See docs/09-agent-integration.md §5.
 */
function launchAgent(where: 'new-tab' | 'split'): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  const size = panesHost?.fit(paneId) ?? { cols: 80, rows: 24 };
  client?.send({ t: 'launch-agent', where, workspaceId, paneId, ...size });
}

function closeFocused(): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  // Closing the only pane would close the workspace, which is what closing the tab is for.
  if (layout && collectPanes(layout).length <= 1) return;
  client?.send({ t: 'close-pane', workspaceId, paneId });
}

function installShortcuts(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && splitView?.maximized) {
        // Leaving focus mode must also release the keyboard lock, or Command+W stays captured
        // for the whole browser.
        if (splitView.inFocusMode) void splitView.exitFocusMode();
        else splitView.toggleMaximize(null);
        e.preventDefault();
        return;
      }
      // Command+K toggles the palette. Chrome does not reserve it and no shell needs it.
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        palette?.toggle();
        e.preventDefault();
        return;
      }
      // Command+Shift only, so nothing here shadows a key the shell needs.
      if (!e.metaKey || !e.shiftKey) return;
      switch (e.key.toLowerCase()) {
        case 'd':
          splitFocused('horizontal');
          e.preventDefault();
          break;
        case 'e':
          splitFocused('vertical');
          e.preventDefault();
          break;
        case 'w':
          closeFocused();
          e.preventDefault();
          break;
        case 'x':
          detachFocused();
          e.preventDefault();
          break;
        case 'm':
          client?.send({ t: 'list-mergeable', workspaceId });
          palette?.openMerge();
          e.preventDefault();
          break;
        case 'enter':
          if (splitView?.focused) splitView.toggleMaximize(splitView.focused);
          e.preventDefault();
          break;
        case 'a':
          // Command+Shift+A opens an agent in a new tab, Option as well puts it in a split.
          launchAgent(e.altKey ? 'split' : 'new-tab');
          e.preventDefault();
          break;
        case 'f':
          // Fullscreen focus mode, the only context where a page can receive Command+W.
          if (splitView?.focused) {
            if (splitView.inFocusMode) void splitView.exitFocusMode();
            else void splitView.enterFocusMode(splitView.focused);
          }
          e.preventDefault();
          break;
        default:
          break;
      }
    },
    { capture: true },
  );
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

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

function onControl(msg: ServerMessage): void {
  /* eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check --
     Deliberately partial: unhandled messages are ignored so a newer daemon does not break an
     older page. */
  switch (msg.t) {
    case 'auth-ok': {
      if (workspaceId) client?.send({ t: 'attach-workspace', workspaceId, cols: 80, rows: 24 });
      else client?.send({ t: 'create-session', cols: 80, rows: 24 });
      return;
    }

    case 'session-created': {
      // A session created for a different workspace means it was launched into a new tab.
      if (attached && workspaceId && msg.workspaceId !== workspaceId) {
        const url = chrome.runtime.getURL(`terminal.html?workspace=${msg.workspaceId}`);
        void chrome.tabs.create({ url, active: true });
        return;
      }
      workspaceId = msg.workspaceId;
      // Put the workspace in the URL so Chrome's own restore returns to this exact layout.
      const url = new URL(location.href);
      url.searchParams.set('workspace', workspaceId);
      history.replaceState(null, '', url.toString());
      client?.send({ t: 'attach-workspace', workspaceId, cols: 80, rows: 24 });
      return;
    }

    case 'workspace-attached': {
      // Creating a pane element is idempotent, and a pane that already exists keeps its
      // terminal untouched. Only genuinely new panes get built.
      for (const p of msg.panes) {
        panesHost?.element(p.paneId, p.sessionId);
        panesHost?.bindStream(p.paneId, p.sessionId, p.streamId);
      }
      applyLayout(msg.layout);
      attached = true;
      for (const p of msg.panes) {
        paneStatus.set(p.paneId, 'idle');
        const state = timeStateFor(p.paneId);
        state.sessionStartedAt ??= Date.now();
      }
      setFavicon(paneStatus.effective());
      startTimeTicking();
      client?.send({ t: 'list-launcher' });
      if (splitView?.focused) panesHost?.focus(splitView.focused);
      return;
    }

    case 'workspace-updated': {
      applyLayout(msg.layout);
      return;
    }

    case 'pane-detached': {
      if (msg.workspaceId === workspaceId && !attached) {
        // This tab was restored after its session had been merged into another one. The
        // daemon handed the session back rather than calling it expired, so this tab simply
        // adopts the workspace it now lives in. See docs/04-session-lifecycle.md §7.
        workspaceId = msg.newWorkspaceId;
        const url = new URL(location.href);
        url.searchParams.set('workspace', workspaceId);
        history.replaceState(null, '', url.toString());
        client?.send({ t: 'attach-workspace', workspaceId, cols: 80, rows: 24 });
        return;
      }
      // A pane left this tab on purpose, so open the tab that now owns it.
      const url = chrome.runtime.getURL(`terminal.html?workspace=${msg.newWorkspaceId}`);
      void chrome.tabs.create({ url, active: true });
      client?.send({ t: 'attach-workspace', workspaceId, cols: 80, rows: 24 });
      return;
    }

    case 'mergeable-sessions': {
      mergeable = [...msg.sessions];
      palette?.setMergeable(mergeable);
      return;
    }

    case 'snapshot': {
      const pane = panesHost?.paneForStream(msg.snapshot.streamId);
      if (pane) panesHost?.restore(pane.paneId, msg.snapshot.screen);
      return;
    }

    case 'paths-resolved': {
      if (msg.cwd && msg.cwd !== currentCwd) {
        currentCwd = msg.cwd;
        pathsInFlight.clear();
      }
      for (const r of msg.results) {
        const key = cacheKey(r.candidate, msg.cwd);
        pathCache.set(key, r);
        pathsInFlight.delete(key);
      }
      panesHost?.refreshLinks();
      return;
    }

    case 'workspace-recall': {
      renderRecoveryActions(msg);
      return;
    }

    case 'launcher-state': {
      launcher?.setState(msg.state);
      savedItems = [...msg.state.saved];
      palette?.setSaved(savedItems);
      // Asked for alongside launcher state, so the chips are there when the panel first draws.
      client?.send({ t: 'list-resumable', limit: 5 });
      client?.send({ t: 'list-servers' });
      return;
    }

    case 'server-detected': {
      showServerOffer(msg.port);
      // The dashboard, if it is on screen, should gain the row rather than wait to be reopened.
      client?.send({ t: 'list-servers' });
      return;
    }

    case 'server-list': {
      launcher?.setServers(msg.servers);
      return;
    }

    case 'resumable-sessions': {
      resumableSessions = msg.sessions;
      launcher?.setResumable(msg.sessions);
      return;
    }

    case 'project-config': {
      launcher?.projectConfig(msg.cwd, msg.config);
      return;
    }

    case 'history-page': {
      palette?.setHistoryPage(msg);
      return;
    }

    case 'saved-updated': {
      savedItems = [...msg.saved];
      palette?.setSaved(savedItems);
      client?.send({ t: 'list-history', query: '', limit: 100 });
      return;
    }

    case 'cwd': {
      currentCwd = msg.cwd;
      titleFields = { ...titleFields, cwd: msg.cwd, ...(msg.gitRoot ? { repo: msg.gitRoot } : {}) };
      refreshTitle();
      panesHost?.refreshLinks();
      return;
    }

    case 'title': {
      titleFields = msg.fields;
      refreshTitle();
      return;
    }

    case 'command-start': {
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      if (pane) {
        const state = timeStateFor(pane.paneId);
        state.commandStartedAt = msg.startedAt;
        state.lastCommand = msg.command;
        paneStatus.set(pane.paneId, 'running');
        setFavicon(paneStatus.effective());
        startTimeTicking();
      }
      return;
    }

    case 'command-end': {
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      if (pane) {
        const state = timeStateFor(pane.paneId);
        const startedAt = state.commandStartedAt;
        const longEnough = startedAt !== undefined && isLongRunning(startedAt);
        if (startedAt !== undefined) state.lastDurationMs = msg.completedAt - startedAt;
        else delete state.lastDurationMs;
        state.lastFinishedAt = msg.completedAt;
        state.lastExitCode = msg.exitCode;
        delete state.commandStartedAt;

        paneStatus.set(pane.paneId, msg.exitCode === 0 ? 'idle' : 'failed');
        setFavicon(paneStatus.effective());
        refreshTitle();
        renderTimeLabels();

        // Only a command that ran long enough for someone to have looked away is worth a
        // status line. A fast one finished before they could miss it.
        if (longEnough) {
          const summary = describeTime({
            ...(state.lastDurationMs !== undefined ? { lastDurationMs: state.lastDurationMs } : {}),
            lastFinishedAt: msg.completedAt,
            lastExitCode: msg.exitCode,
          });
          setStatus(
            `${state.lastCommand ?? 'Command'} ${summary}`,
            msg.exitCode === 0 ? 'ok' : 'warn',
          );
          setTimeout(() => setStatus('', 'hidden'), 4000);
        }
      }
      return;
    }

    case 'agent-state': {
      // Structured, from the agent's own hooks. Never inferred from what is on screen.
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      if (pane) {
        const state: FaviconState =
          msg.state === 'approval'
            ? 'approval'
            : msg.state === 'waiting'
              ? 'waiting'
              : msg.state === 'working'
                ? 'running'
                : msg.state === 'failed'
                  ? 'failed'
                  : 'idle';
        paneStatus.set(pane.paneId, state);
        setFavicon(paneStatus.effective());
        titleFields = { ...titleFields, status: msg.state };
        refreshTitle();
      }
      return;
    }

    case 'process-state': {
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      const state: FaviconState =
        msg.state === 'running'
          ? 'running'
          : msg.state === 'failed'
            ? 'failed'
            : msg.state === 'waiting' || msg.state === 'approval'
              ? msg.state
              : 'idle';
      if (pane) paneStatus.set(pane.paneId, state);
      setFavicon(paneStatus.effective());
      refreshTitle();
      return;
    }

    case 'session-exited': {
      // A pane whose process ended is removed by the daemon, which sends a new layout.
      setFavicon(msg.exitCode === 0 ? 'idle' : 'failed');
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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Identity for this connection.
 *
 * A session tracks its attached clients by id, so two tabs sharing one id means the second
 * silently replaces the first: output stops reaching one of them and resize arbitration sees
 * one client where there are two. The profile id identifies the Chrome profile, and a
 * per-view suffix keeps each tab distinct within it.
 */
async function connectionId(): Promise<string> {
  const KEY = 'tabterm.clientId';
  const got = await chrome.storage.local.get(KEY);
  let profileId = got[KEY] as string | undefined;
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY]: profileId });
  }
  return `${profileId}:${crypto.randomUUID()}`;
}

declare global {
  interface Window {
    __tabterm?: {
      readScreen: (paneId?: string) => string;
      workspaceId: () => string;
      paneIds: () => string[];
      attached: () => boolean;
      split: (direction: 'horizontal' | 'vertical') => void;
      closePane: () => void;
      detachPane: () => void;
      launchAgent: (where: 'new-tab' | 'split') => void;
      saveItem: (body: string, title?: string) => void;
      mergeSession: (sessionId: string) => void;
      listMergeable: () => MergeableSession[];
      focus: (paneId: string) => void;
      probePaths: () => string[];
      resolvedPaths: () => ResolvedPath[];
    };
  }
}

/**
 * Testing surface.
 *
 * The WebGL renderer draws to a canvas, so terminal text is absent from the DOM and cannot be
 * read by an automated check. This exposes the buffer instead. It reveals nothing the page does
 * not already hold, and extension pages cannot be scripted from outside the extension.
 */
function installTestHook(): void {
  window.__tabterm = {
    readScreen: (paneId) => {
      const target = paneId ?? splitView?.focused ?? panesHost?.all[0]?.paneId;
      const pane = target ? panesHost?.get(target) : undefined;
      if (!pane) return '';
      const buf = pane.controller.term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    workspaceId: () => workspaceId,
    paneIds: () => (layout ? collectPanes(layout) : []),
    attached: () => attached,
    split: (direction) => splitFocused(direction),
    closePane: () => closeFocused(),
    detachPane: () => detachFocused(),
    mergeSession: (sessionId) => {
      const targetPaneId = splitView?.focused;
      if (!targetPaneId || !workspaceId) return;
      client?.send({
        t: 'merge-into',
        workspaceId,
        targetPaneId,
        sessionId,
        direction: 'horizontal',
      });
    },
    launchAgent: (where) => launchAgent(where),
    saveItem: (body, title) => {
      client?.send({ t: 'save-item', title: title ?? body.slice(0, 60), body });
    },
    listMergeable: () => {
      if (workspaceId) client?.send({ t: 'list-mergeable', workspaceId });
      return mergeable;
    },
    focus: (paneId) => splitView?.focus(paneId),
    probePaths: () => {
      const screen = window.__tabterm?.readScreen() ?? '';
      const found = [
        ...new Set(screen.split('\n').flatMap((l) => findCandidates(l).map((c) => c.text))),
      ];
      const pane = panesHost?.get(splitView?.focused ?? '');
      const unknown = found.filter(
        (x) => !pathCache.has(cacheKey(x)) && !pathsInFlight.has(cacheKey(x)),
      );
      if (unknown.length > 0 && pane) {
        for (const x of unknown) pathsInFlight.add(cacheKey(x));
        client?.send({ t: 'resolve-paths', sessionId: pane.sessionId, candidates: unknown });
      }
      return found;
    },
    resolvedPaths: () => [...pathCache.values()],
  };
}

async function start(): Promise<void> {
  const token = await getToken();
  if (!token) {
    showRecovery('TabTerm is not paired with the daemon yet.');
    return;
  }

  buildHosts();
  buildLauncher();
  installTestHook();
  installModifierTracking();
  installShortcuts();
  // Leaving fullscreen by any route, including the Escape the browser handles itself, must
  // put the layout back and release the lock.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && splitView?.maximized) void splitView.exitFocusMode();
  });
  setFavicon('disconnected');
  refreshTitle();

  // A command handed over by a context menu. It is only ever displayed here; nothing sends it
  // anywhere until the user says so.
  const staged = params.get('staged');
  if (staged) showStaged(staged, params.get('stagedFrom') ?? 'a webpage');

  client = new DaemonClient({
    port: DEFAULT_PORT,
    token,
    clientId: await connectionId(),
    role: 'data',
    onControl,
    onOutput: (streamId, data) => {
      panesHost?.write(streamId, data, (bytes) => client?.ack(streamId, bytes));
    },
    onStatus: statusFor,
  });
  client.connect();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (splitView?.focused) panesHost?.focus(splitView.focused);
      setFavicon(faviconState);
      startTimeTicking();
    } else {
      clearInterval(animTimer);
      animTimer = undefined;
      // A hidden tab throttles timers anyway, and nobody is reading the label.
      stopTimeTicking();
    }
  });
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
