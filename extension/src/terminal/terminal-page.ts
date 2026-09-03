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
import { daemonPort } from '../transport/port.js';
import { SplitView, collectPanes } from '../layout/split-view.js';
import { PaneHost } from './panes.js';
import { PaneChooser } from './pane-chooser.js';
import { openLabelForm } from './label-form.js';
import { describeError } from './describe-error.js';
import type { PaneMenuAction } from './xterm-controller.js';
import { findCandidates } from './path-links.js';
import { TypedBuffer, backspaces } from './hotstrings.js';
import { chooseOpenAction, describeOpen } from './open-action.js';
import { needsAttention, StatusMachine, titleStatus } from './status-machine.js';
import { describeTime, isLongRunning, type TimeState } from './elapsed.js';
import { applyFavicon, composeTitle, drawFavicon, type FaviconState } from './titles.js';
import { TabFlasher, flashingSessions, setFlashing } from './flash-on-finish.js';
import { Launcher } from '../launcher/launcher.js';
import { CommandPanel } from '../launcher/panel-view.js';
import { DEFAULT_PLACEMENT, type PanelPlacement } from '../launcher/command-panel.js';
import { buildSettings } from '../launcher/settings-view.js';
import { buildReset, buildResetDone } from '../launcher/reset-view.js';
import { quotePath } from './quote-path.js';
import { DEFAULT_THEME, themeNamed } from './themes.js';
import { DEFAULT_COLOR, loadRecentColors, rememberColor, type ColorUse } from './color-store.js';
import { loadTemplates, saveTemplates, type LayoutTemplate } from '../launcher/templates.js';
import type {
  AgentHooksStatus,
  LiveSession,
  NotifyPolicy,
  ShellIntegrationStatus,
} from '@tabterm/shared';
import { buildStats } from '../launcher/stats-view.js';
import { SessionStats } from '../launcher/session-stats.js';
import { Palette, type PaletteAction } from '../launcher/palette.js';

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

const params = new URLSearchParams(location.search);

/**
 * Whether this page is reattaching to a workspace that already exists.
 *
 * The start panel belongs to a *new* tab: it is drawn over an empty terminal because there is
 * no output yet. A page that opened with a workspace in its URL is not that. It is a session
 * somebody already has, most often because they reloaded, and it may have a screen full of
 * output -- which used to end up crammed into the small strip the panel leaves behind.
 *
 * Read once at load, because the URL gains a workspace id as soon as a session is created and
 * would otherwise stop telling the two cases apart.
 */
const reattaching = params.has('workspace');
/** Opened from the toolbar icon's settings entry, so the panel starts on that pane. */
const openPanelAt = params.get('panel');

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
const paneStatus = new StatusMachine();
/**
 * Daemon-owned settings, mirrored here for the settings pane to render.
 *
 * Null until it answers, which the pane says rather than guessing at a default and showing a
 * switch in a position the daemon might disagree with.
 */
let notifyPolicy: NotifyPolicy | null = null;
let agentHooks: AgentHooksStatus | null = null;
let shellIntegration: ShellIntegrationStatus | null = null;
let scrollbackBytes: number | null = null;
let backgroundTimeout: number | null | undefined;
/**
 * Something was asked for from this tab's start screen, so what it creates belongs here.
 *
 * Set by every start-screen action that makes a workspace: a layout, a project template, and
 * resuming an agent. A tab showing a list of ways to begin is empty by definition, and choosing
 * one of them means "begin here". Opening a second tab left this one sitting on the menu beside
 * the thing it had just started, which is a tab nobody wanted.
 */
let layoutRequestedHere = false;

/**
 * Whether the question "is this tab empty?" can be answered yet.
 *
 * False until a reattaching tab has had time to restore its screen. Until then every tab looks
 * empty, and drawing the start screen on that basis is what made it flash up and vanish.
 */
let startScreenDecided = !reattaching;
/** A template whose commands are waiting for its panes to exist. */
let pendingTemplate: LayoutTemplate | null = null;

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
  document.title = composeTitle(titleFields, status ?? titleStatus(paneStatus, count));
}

/**
 * A way back from a clear, for a few seconds.
 *
 * Clearing is a reflex, and a reflex that can destroy an hour of output needs a way back. The
 * durable copies are already gone by the time this appears, so undo restores only what this tab
 * still had in memory, which is the compromise that keeps clearing honest.
 */
let clearUndoTimer: number | undefined;

function offerClearUndo(paneId: string): void {
  const button = document.getElementById('clear-undo');
  if (!(button instanceof HTMLButtonElement)) return;
  clearTimeout(clearUndoTimer);
  button.hidden = false;
  button.onclick = () => {
    const pane = panesHost?.get(paneId);
    const text = pane?.controller.takeUndo() ?? '';
    /**
     * Written **over** the prompt, not after it.
     *
     * Clearing ends with the shell redrawing its prompt at the top of the screen, so appending
     * here put the restored screen to the right of a live prompt and left a second copy of that
     * prompt above everything. The restored text ends with the prompt line the shell drew before
     * the clear, which is the same text at the same column, so overwriting the line puts the
     * cursor exactly where the shell already believes it is.
     */
    if (text) {
      const toLineStart = `\r${String.fromCharCode(27)}[2K`;
      pane?.controller.write(new TextEncoder().encode(toLineStart + text), () => {});
    }
    dismissClearUndo(paneId);
  };
  // Ten seconds, and gone the moment anything else is run: an undo offered over new output
  // would put the old screen underneath the new one.
  clearUndoTimer = window.setTimeout(() => dismissClearUndo(paneId), 10_000);
}

/**
 * Command+Z, while the undo is being offered.
 *
 * The same action as the button, reached the way undo is reached everywhere else. The offer is
 * already bounded to ten seconds and to "nothing has run since", so this borrows those limits
 * rather than inventing its own: outside that window the key is not ours and goes to the shell,
 * where Command+Z means nothing anyway.
 */
function undoClearIfOffered(): boolean {
  const button = document.getElementById('clear-undo');
  if (!(button instanceof HTMLButtonElement) || button.hidden) return false;
  button.click();
  return true;
}

function dismissClearUndo(paneId?: string): void {
  clearTimeout(clearUndoTimer);
  clearUndoTimer = undefined;
  const button = document.getElementById('clear-undo');
  if (button instanceof HTMLButtonElement) button.hidden = true;
  if (paneId) panesHost?.get(paneId)?.controller.forgetUndo();
}

/**
 * Ask before ending everything.
 *
 * Replaces the whole page rather than opening a dialog over a terminal: this tab exists only to
 * ask the question, and a confirmation drawn over a working terminal invites answering it while
 * looking at something else.
 */
function showResetConfirmation(sessions: readonly LiveSession[]): void {
  void chrome.runtime.sendMessage({ t: 'tabterm:count-terminal-tabs' }).then((reply: unknown) => {
    const tabCount = Number((reply as { count?: number } | undefined)?.count ?? 1);
    document.body.replaceChildren(
      buildReset({
        sessions,
        tabCount,
        onCancel: () => window.close(),
        onConfirm: (restartDaemon) => {
          client?.send({ t: 'reset-everything', restartDaemon });
        },
      }),
    );
  });
}

/**
 * Which sessions asked for their tab to flash when a command finishes.
 *
 * Held in memory as well as in storage, so the menu can be built and measured without waiting
 * on a read. Refreshed whenever it changes.
 */
let flashing = new Set<string>();

function refreshFlashing(): void {
  void flashingSessions().then((set) => (flashing = set));
}

/**
 * Two alternating icons, painted over whatever the tab would otherwise show.
 *
 * `done` and `failed` are the two the product already draws for a finished command, so the
 * flash is those two rather than a third thing nobody has seen before.
 */
const tabFlasher = new TabFlasher((on) => {
  applyFavicon(drawFavicon(on ? 'done' : 'idle', animPhase));
});

/**
 * Remove the lone `%` zsh sometimes leaves above the first prompt.
 *
 * It is zsh's partial-line marker: output that did not end in a newline gets an inverse `%` so
 * the prompt starts on a clean line. It is correct and it is noise, and on the start screen,
 * where the terminal is a two-line strip, it takes half of what you can see.
 *
 * Removed by asking the shell to redraw rather than by editing the buffer, so the screen stays
 * something the shell produced. Only when it is the only thing above the prompt, and only while
 * the start screen is up: over real output that marker is telling you something true.
 */
function tidyPartialLine(paneId: string): void {
  const pane = panesHost?.get(paneId);
  if (!pane || launcher?.dismissed !== false) return;
  const buffer = pane.controller.term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length && lines.length < 3; y++) {
    const text = (buffer.getLine(y)?.translateToString(true) ?? '').trim();
    if (text !== '') lines.push(text);
  }
  if (lines.length !== 2 || lines[0] !== '%') return;
  // Ctrl+L: the shell's own clear-and-redraw, which is what puts the prompt back cleanly.
  client?.write(pane.streamId, new TextEncoder().encode(String.fromCharCode(12)));
}

function setFavicon(state: FaviconState): void {
  // A flash is a deliberate override and outranks the ordinary icon until it is noticed.
  if (tabFlasher.flashing) return;
  faviconState = state;
  clearInterval(animTimer);
  animTimer = undefined;
  // In the lowest memory mode a hidden tab stops redrawing its icon. Nothing is lost: the
  // favicon is brought up to date the moment the tab is looked at again.
  if (!memorySettings.faviconWhileHidden && document.visibilityState === 'hidden') return;
  applyFavicon(drawFavicon(state, animPhase));

  const visible = document.visibilityState === 'visible';
  /**
   * Animation only where it can happen.
   *
   * A hidden tab cannot drive its own: measured at **one frame per minute** from the second
   * minute onward, so a pulse there would be a still image that occasionally jumps. The pane
   * that needs a person gets a distinct static icon instead, and the thing that actually
   * reaches somebody who is looking elsewhere is the notification.
   * See docs/10-limitations.md tier 1.1.
   */
  if (!visible) return;
  if (state === 'running') {
    animTimer = window.setInterval(() => {
      animPhase++;
      applyFavicon(drawFavicon('running', animPhase));
    }, 200);
  } else if (needsAttention(state)) {
    animTimer = window.setInterval(() => {
      animPhase++;
      applyFavicon(drawFavicon(state, animPhase));
    }, 220);
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
  lastScreen?: readonly string[];
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

    /**
     * What was on the screen when it ended.
     *
     * The processes are gone and cannot come back, but the output is still here, so the tab can
     * show what happened rather than only where it happened. Without this the history is
     * written, bounded, pruned and never seen by anybody.
     */
    if (recall.lastScreen && recall.lastScreen.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'recovery-key';
      heading.textContent = 'Last output';
      detail.append(heading);

      const screen = document.createElement('div');
      screen.className = 'session-screen recovery-screen';
      for (const line of recall.lastScreen) {
        const lineEl = document.createElement('div');
        lineEl.className = 'session-line';
        lineEl.textContent = line === '' ? '\u00a0' : line;
        screen.append(lineEl);
      }
      detail.append(screen);
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

/**
 * The chooser drawn over a pane that has nothing in it.
 *
 * Only for a workspace with more than one pane. A single pane already has the start screen over
 * it, and two panels saying the same thing would be worse than one.
 */
const paneChoosers = new Map<string, PaneChooser>();

function syncPaneChoosers(): void {
  const paneIds = layout ? collectPanes(layout) : [];
  for (const [paneId, chooser] of paneChoosers) {
    if (!paneIds.includes(paneId)) {
      chooser.dismiss();
      paneChoosers.delete(paneId);
    }
  }
  if (paneIds.length < 2) return;

  for (const paneId of paneIds) {
    if (paneChoosers.has(paneId)) continue;
    const pane = panesHost?.get(paneId);
    if (!pane) continue;
    /**
     * Only a pane with nothing in it.
     *
     * Every pane in a multi-pane tab used to get one, so a session merged into a pane arrived
     * with a chooser drawn over its output, offering to replace what had just been put there.
     * A fresh shell has printed a prompt and nothing else; anything more means the pane is in
     * use and has no business being covered.
     */
    if (linesWithContent(pane.controller.term) > 1) continue;
    paneChoosers.set(
      paneId,
      new PaneChooser({
        container: pane.element,
        paneId,
        home: launcherHome,
        onChooseDir: (id, path) => {
          const target = panesHost?.get(id);
          if (!target) return;
          splitView?.focus(id);
          client?.write(target.streamId, new TextEncoder().encode(`cd ${quotePath(path)}\r`));
          paneChoosers.get(id)?.dismiss();
        },
        onListFolder: (path) => {
          // The same completion the start screen browses with: a trailing slash asks for what
          // is inside a directory rather than for a suggestion.
          completingPane = paneId;
          client?.send({ t: 'complete-path', partial: path });
        },
        onTakeSession: (id, session) => {
          if (!workspaceId) return;
          // Moving it, not copying it: a session lives in exactly one workspace, so the tab it
          // came from is asked to close rather than left showing a workspace with nothing in it.
          takingOverFrom.add(session.workspaceId);
          client?.send({
            t: 'merge-into',
            workspaceId,
            targetPaneId: id,
            sessionId: session.sessionId,
            direction: 'horizontal',
          });
          paneChoosers.get(id)?.dismiss();
        },
        onRefreshSessions: () => {
          if (workspaceId) client?.send({ t: 'list-mergeable', workspaceId });
        },
      }),
    );
  }
}

/** How much a pane has printed, which is how an empty one is told from one in use. */
/**
 * Has anything happened in this tab yet?
 *
 * True for a tab that is still showing its start screen with a shell nobody has typed into:
 * one pane, one line on it, which is the prompt. That is the tab that should be taken over or
 * closed rather than left beside whatever was just opened.
 *
 * Deliberately conservative. Anything it cannot be sure about counts as used, because closing a
 * tab somebody was working in is far worse than leaving an empty one.
 */
function thisTabIsUnused(): boolean {
  const panes = panesHost?.all ?? [];
  if (panes.length !== 1) return false;
  const only = panes[0];
  if (!only) return false;
  return linesWithContent(only.controller.term) <= 1;
}

/**
 * Where a command was run, if its line is still in the buffer.
 *
 * Matched on the text of the command, searching from the end, because the row a person means by
 * "this one" is the most recent time they ran it. Null when the output has scrolled off, which
 * is what keeps the offer honest.
 */
function findCommandRow(command: string): number | null {
  const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
  if (!pane) return null;
  const wanted = command.trim();
  if (wanted === '') return null;
  const buffer = pane.controller.term.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row--) {
    const text = buffer.getLine(row)?.translateToString(true) ?? '';
    if (text.includes(wanted)) return row;
  }
  return null;
}

function linesWithContent(term: {
  buffer: {
    active: {
      length: number;
      getLine: (y: number) => { translateToString: (trim: boolean) => string } | undefined;
    };
  };
}): number {
  const buffer = term.buffer.active;
  let count = 0;
  for (let y = 0; y < buffer.length; y++) {
    if ((buffer.getLine(y)?.translateToString(true) ?? '').trim() !== '') count++;
    if (count > 1) return count;
  }
  return count;
}

/** Workspaces this tab has just taken a session from, so their tabs know to close. */
const takingOverFrom = new Set<string>();
/** Which pane asked for a completion, since the answer comes back on one channel. */
let completingPane: string | null = null;
/** Home, as the daemon reports it, for shortening paths in a pane chooser. */
let launcherHome = '';

function setCmdHeld(held: boolean): void {
  if (held === cmdHeld) return;
  cmdHeld = held;
  document.body.classList.toggle('cmd-held', held);
  panesHost?.refreshLinks();
}

/**
 * Keep the terminal ready to type into, always.
 *
 * A terminal has no other controls, so nobody expects to have to click into one before typing.
 * This page does have other controls -- the launcher, its buttons, the palette -- and clicking
 * any of them takes DOM focus away, after which keystrokes went nowhere. That is not a terminal.
 *
 * The rule: **if you are not deliberately typing into a text field, you are typing into the
 * terminal.** Focus is moved on the way in, during the capture phase, so the keystroke that
 * triggered it lands in the terminal rather than being swallowed as the price of getting there.
 *
 * A real text field keeps its keys: the palette's search box, the launcher's path box, and the
 * placeholder inputs are all places where typing means something else, and each one is where
 * the user deliberately put the cursor.
 */
function installAmbientFocus(): void {
  const isTextField = (node: EventTarget | null): boolean => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    // xterm's own hidden textarea is the terminal, not a competing field.
    if (node.classList.contains('xterm-helper-textarea')) return false;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  // Escape closes the panel wherever focus happens to be. Clicking into the terminal while it
  // is open is a reasonable thing to do, and it should not leave the panel with no way out
  // except reaching for the mouse.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && commandPanel?.isOpen) {
        e.preventDefault();
        commandPanel.close();
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      // The command panel takes the keyboard while it is open. Two surfaces cannot both be
      // active, and a terminal that keeps accepting keystrokes behind an open list is the
      // clearest way to type into the wrong one.
      if (commandPanel?.isOpen) return;
      if (isTextField(document.activeElement)) return;
      // Browser and system shortcuts are not typing, and stealing focus for them would move the
      // cursor for something that never reaches the page anyway.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const paneId = splitView?.focused ?? panesHost?.all[0]?.paneId;
      if (paneId) panesHost?.focus(paneId);
    },
    true,
  );

  // Clicking a button does its job and hands the keyboard straight back, so the next thing you
  // type goes where it would have gone if you had never touched the mouse.
  document.addEventListener('click', (e) => {
    if (isTextField(e.target)) return;
    if (palette?.isOpen || commandPanel?.isOpen) return;
    // A click inside the panel belongs to the panel.
    if (e.target instanceof HTMLElement && e.target.closest('.cmd-panel, .cmd-puck')) return;
    // A click inside a pane is already handled by the pane itself, which focuses the right one.
    if (e.target instanceof HTMLElement && e.target.closest('.pane')) return;
    const paneId = splitView?.focused ?? panesHost?.all[0]?.paneId;
    if (!paneId) return;
    setTimeout(() => {
      // Unless the click opened something that wants the keyboard. A menu entry is not a text
      // field, so this fired for every one of them and took focus back from the form the entry
      // had just opened, which is why naming anything meant clicking into the box first.
      if (isTextField(document.activeElement)) return;
      panesHost?.focus(paneId);
    }, 0);
  });
}

function installModifierTracking(): void {
  window.addEventListener('keydown', (e) => setCmdHeld(e.metaKey), { capture: true });
  window.addEventListener('keyup', (e) => setCmdHeld(e.metaKey), { capture: true });
  // Capture, so the modifier is known before xterm asks its link providers about the line
  // under the pointer. Bubbling ran after that question was already answered, and xterm caches
  // the answer per line, so moving along a path never asked again and the link stayed inert.
  window.addEventListener('mousemove', (e) => setCmdHeld(e.metaKey), { capture: true });
  window.addEventListener('blur', () => setCmdHeld(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') setCmdHeld(false);
  });
}

// ---------------------------------------------------------------------------
// Panes and layout
// ---------------------------------------------------------------------------

/** Counts bytes xterm has emitted, so a dead input path can be told apart from a dead renderer. */
let inputBytesSeen = 0;
/** Why the last edit was refused, so a test or a panel can report it. */
let lastSaveRejection = '';

/** What has been typed in each pane, for hotstring expansion. One per pane, never shared. */
const typedBuffers = new Map<string, TypedBuffer>();

/** Hotstrings come from the favorites the page already has. No separate message for them. */
function hotstrings(): { trigger: string; command: string }[] {
  return savedItems
    .filter((item) => item.hotstring)
    .map((item) => ({ trigger: item.hotstring as string, command: item.body }));
}
let lastStatus = 'unknown';

function buildHosts(): void {
  panesHost = new PaneHost({
    menuActions: (paneId) => paneMenuActions(paneId),
    highlightColor: () => recentColors.highlight[0] ?? DEFAULT_COLOR.highlight,
    highlightRecents: () => recentColors.highlight,
    onColorUsed: (color) => useColor('highlight', color),
    onData: (paneId, data) => {
      inputBytesSeen += data.length;
      const pane = panesHost?.get(paneId);
      if (!pane) return;

      // Hotstrings act on the keystroke before it reaches the shell. Suspended while a
      // full-screen program owns the terminal, because the deletions this sends would be edits
      // there rather than corrections. See docs/14-command-menu.md §4.
      let typed = typedBuffers.get(paneId);
      if (!typed) {
        typed = new TypedBuffer();
        typedBuffers.set(paneId, typed);
      }
      typed.setSuspended(pane.controller.term.buffer.active.type === 'alternate');

      const expansion = typed.consume(data, hotstrings());
      if (expansion) {
        launcher?.dismiss();
        const rewritten = backspaces(expansion.deleteCount) + expansion.insert;
        client?.write(pane.streamId, new TextEncoder().encode(rewritten));
        return;
      }
      // The panel survives typing and goes when a command is actually sent. It is not a page
      // you leave to reach the terminal: the terminal is already underneath it, and what is
      // drawn on top is only there because there is no output yet. Dismissing on the first
      // keystroke made a half-typed command the moment everything disappeared, which is both
      // startling and useless, since that is exactly when you might still want the list.
      if (submitsCommand(data)) {
        launcher?.dismiss();
        paneChoosers.get(paneId)?.dismiss();
      }
      client?.write(pane.streamId, new TextEncoder().encode(data));
    },
    onResize: (paneId, cols, rows) => {
      if (workspaceId) client?.send({ t: 'resize-pane', workspaceId, paneId, cols, rows });
    },
    onClear: (paneId) => {
      const pane = panesHost?.get(paneId);
      if (pane?.sessionId) client?.send({ t: 'clear-scrollback', sessionId: pane.sessionId });
      offerClearUndo(paneId);
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

/**
 * The last few colors, per use, held in memory as well as in storage.
 *
 * A right-click menu is built and measured synchronously, so it cannot wait on a storage read to
 * know what color the swatch should be. This is refreshed whenever one is used and read once at
 * startup, and being briefly out of date costs nothing: the worst case is a swatch showing the
 * previous color for one menu.
 */
const recentColors: Record<ColorUse, string[]> = {
  title: [DEFAULT_COLOR.title],
  marker: [DEFAULT_COLOR.marker],
  highlight: [DEFAULT_COLOR.highlight],
};

function refreshRecentColors(): void {
  for (const use of ['title', 'marker', 'highlight'] as const) {
    void loadRecentColors(use).then((list) => (recentColors[use] = [...list]));
  }
}

function useColor(use: ColorUse, color: string): void {
  recentColors[use] = [color, ...recentColors[use].filter((c) => c !== color)].slice(0, 5);
  void rememberColor(use, color);
}

/** Conversations the person has taken out of the resume list. */
const hiddenResumes = new Set<string>();

function loadHiddenResumes(): void {
  void chrome.storage.local.get('tabterm.hiddenResumes').then((stored) => {
    const list: unknown = stored['tabterm.hiddenResumes'];
    if (!Array.isArray(list)) return;
    for (const id of list) if (typeof id === 'string') hiddenResumes.add(id);
    launcher?.setHiddenResumes([...hiddenResumes]);
  });
}

function buildLauncher(): void {
  const overlay = document.getElementById('overlays') as HTMLElement;

  launcher = new Launcher({
    root: overlay,
    onCheckFolder: (path) => client?.send({ t: 'check-folder', path }),
    onCreateFolder: (path) => client?.send({ t: 'create-folder', path }),
    onChooseDir: (path) => {
      // Send a real `cd` rather than restarting the session: the shell you are already in is
      // the one you want, just somewhere else.
      sendToFocusedPane(`cd ${quote(path)}\r`);
      launcher?.dismiss();
    },
    onSaveTemplate: (template) => {
      void loadTemplates().then(async (existing) => {
        const next = [...existing.filter((t) => t.name !== template.name), template];
        await saveTemplates(next);
        launcher?.setTemplates(next);
        setStatus(`Saved "${template.name}"`, 'ok');
        setTimeout(() => setStatus('', 'hidden'), 2500);
      });
    },
    onDeleteTemplate: (id) => {
      void loadTemplates().then(async (existing) => {
        const next = existing.filter((t) => t.id !== id);
        await saveTemplates(next);
        launcher?.setTemplates(next);
      });
    },
    onRunTemplate: (template) => {
      /**
       * Build the layout, then stage each command in its pane.
       *
       * Staged rather than run, the same as every other saved thing here. A template that
       * executed on click is how somebody deploys by mis-clicking a menu.
       */
      pendingTemplate = template;
      layoutRequestedHere = true;
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({
        t: 'create-layout',
        path: template.path,
        panes: template.panes,
        direction: 'horizontal',
        shape: template.shape,
        createIfMissing: true,
        ...size,
      });
      launcher?.dismiss();
    },
    onDropRejected: () => {
      setStatus('That drop carried no path. Finder cannot provide one, see the docs.', 'warn');
      setTimeout(() => setStatus('', 'hidden'), 4000);
    },
    onCreateLayout: (path, panesWanted, direction, shape) => {
      layoutRequestedHere = true;
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({
        t: 'create-layout',
        path,
        panes: panesWanted,
        direction,
        ...(shape ? { shape } : {}),
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
    onCompletePath: (partial) => client?.send({ t: 'complete-path', partial }),
    onOpenSession: (session) => {
      /**
       * Go to the session, wherever it is.
       *
       * A session already shown in a tab is focused rather than attached again, because two
       * views of one terminal is something people create by accident and never on purpose.
       *
       * The tab doing the clicking is deliberately left alone when the session lives elsewhere.
       * Dismissing its start screen would reveal its own empty terminal at the same moment
       * focus moves away, so coming back to it later looks exactly like the click opened a
       * second copy. It did not; this tab simply stopped showing the list.
       */
      if (!session.workspaceId) return;

      /**
       * Taken over here when this tab has nothing in it. Never opened beside it.
       *
       * This has been reported twice. A session running in the background was handed to the
       * service worker, which opens the workspace in a **new** tab, leaving the tab that was
       * clicked in sitting on a bare shell in the home directory. Two tabs for one action, and
       * the one you were looking at is the useless one.
       *
       * Navigating is what takes it over. The reattach path already knows how to restore a
       * workspace into a tab, so this borrows it whole rather than growing a second way to do
       * the same thing. The shell this tab was holding is untouched and never used, so the
       * policy that clears untouched panes away takes it in its own time.
       */
      const spare = thisTabIsUnused();
      if (!session.attached && spare) {
        location.href = chrome.runtime.getURL(`terminal.html?workspace=${session.workspaceId}`);
        return;
      }

      /**
       * Already open somewhere, so that tab is brought forward and **this one goes**.
       *
       * Leaving it was the previous behavior, on the reasoning that dismissing its start screen
       * would reveal its own empty terminal at the moment focus moved away, which reads as a
       * second copy of the session. Closing it answers that better: there is no tab left to be
       * confused by. Only ever a tab nobody has used.
       */
      void chrome.runtime.sendMessage({
        t: 'tabterm:focus-workspace',
        workspaceId: session.workspaceId,
        attachHere: !session.attached,
      });
      if (!session.attached) launcher?.dismiss();
      if (spare) {
        // After the focus message, so the tab being switched to is already in front.
        setTimeout(() => window.close(), 120);
      }
    },
    onCloseSession: (session) => {
      client?.send({ t: 'kill-session', sessionId: session.sessionId });
      // A tab showing a session that no longer exists is a tab showing an apology, so it goes
      // with the session it was showing.
      if (session.workspaceId) {
        void chrome.runtime.sendMessage({
          t: 'tabterm:close-workspace-tab',
          workspaceId: session.workspaceId,
        });
      }
      setTimeout(() => client?.send({ t: 'list-live-sessions' }), 400);
    },
    onRestore: (workspaceId, replayCommands) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({ t: 'restore-workspace', workspaceId, replayCommands, ...size });
      launcher?.dismiss();
    },
    onForgetRestorable: (workspaceId) => {
      client?.send({ t: 'forget-restorable', workspaceId });
      client?.send({ t: 'list-restorable' });
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
    /**
     * A conversation dismissed from the list stays dismissed.
     *
     * In extension storage rather than the daemon: this is a view of somebody's own history,
     * and hiding a row is a statement about what they want to see rather than about the
     * conversation, which is still on disk and still resumable from the agent's own tools.
     */
    onHideResume: (sessionId) => {
      hiddenResumes.add(sessionId);
      void chrome.storage.local.set({ 'tabterm.hiddenResumes': [...hiddenResumes] });
    },
    onResumeAgent: (session) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      // Resumed into this tab, not beside it. Asked for here, so it belongs here.
      if (thisTabIsUnused()) layoutRequestedHere = true;
      client?.send({
        t: 'resume-agent',
        sessionId: session.sessionId,
        cwd: session.cwd,
        agent: session.agent,
        ...size,
      });
      launcher?.dismiss();
    },
    onOpenProject: (path) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? { cols: 80, rows: 24 };
      client?.send({ t: 'launch-project-template', cwd: path, ...size });
      launcher?.dismiss();
    },
    onDismiss: () => {
      // The terminal takes the whole window back. Its size genuinely changes, so the shell is
      // told, and it redraws into the space it now has.
      root.classList.remove('panel-open');
      refitAllPanes();
      panesHost?.focus(splitView?.focused ?? '');
    },
  });

  palette = new Palette({
    root: overlay,
    onQuery: (query, scope, offset) => {
      // Rebuilt per query, because which actions make sense depends on the layout right now.
      palette?.setActions(paletteActions());
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

const quote = quotePath;

/** The session behind the focused pane, which is what a scoped search resolves against. */
/**
 * The memory mode's frontend half.
 *
 * Defaults match `balanced`, so a page that has not heard from the daemon yet behaves the way
 * the shipped configuration does rather than the most aggressive one.
 */
let memorySettings = {
  rendererUnloadMs: 120_000,
  faviconWhileHidden: true,
  scrollbackLines: 10_000,
};
let rendererTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Release renderers after a tab has been hidden for a while.
 *
 * Not immediately: flicking between two tabs is common, and tearing down a WebGL context on
 * every switch would cost more than it saves. The delay is what the memory mode sets.
 */
function scheduleRendererRelease(): void {
  clearTimeout(rendererTimer);
  rendererTimer = setTimeout(() => {
    if (document.visibilityState === 'hidden') panesHost?.releaseRenderers();
  }, memorySettings.rendererUnloadMs);
}

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
  // Same rule as typing: pasting a command leaves the panel up, running one takes it away.
  if (submitsCommand(text)) launcher?.dismiss();
}

/**
 * Whether this input submits a command rather than editing one.
 *
 * A carriage return is what a shell treats as "run it", which is exactly the moment the user
 * has stopped choosing and started working.
 */
/**
 * Re-measure every pane after the available space changes.
 *
 * A terminal that is not told it grew keeps wrapping to its old width, which looks like a
 * rendering bug and is really a stale size.
 */
function refitAllPanes(): void {
  for (const pane of panesHost?.all ?? []) {
    const size = panesHost?.fit(pane.paneId);
    if (size && workspaceId) {
      client?.send({ t: 'resize-pane', workspaceId, paneId: pane.paneId, ...size });
    }
  }
}

function submitsCommand(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
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
  syncPaneChoosers();
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

/**
 * What the right-click menu offers for one pane.
 *
 * Asked for at the moment of the click, so it describes the pane as it is: a pane with no
 * siblings cannot be detached or closed, and saying so greyed out is clearer than an entry that
 * silently does nothing.
 *
 * Every entry targets the pane that was clicked rather than the focused one, by focusing it
 * first. Right-clicking a pane and having the action land somewhere else would be a trap.
 */
/** What a pane is currently called, read from the layout, which is where it lives. */
function paneLabel(paneId: string): { label: string; color?: string } {
  const walk = (node: LayoutNode): { label: string; color?: string } | null => {
    if (node.type === 'terminal') {
      if (node.paneId !== paneId) return null;
      return { label: node.label ?? '', ...(node.labelColor ? { color: node.labelColor } : {}) };
    }
    return walk(node.children[0]) ?? walk(node.children[1]);
  };
  return (layout ? walk(layout) : null) ?? { label: '' };
}

function paneMenuActions(paneId: string): PaneMenuAction[] {
  const paneCount = layout ? collectPanes(layout).length : 1;
  const hasSiblings = paneCount > 1;
  const session = panesHost?.get(paneId)?.sessionId ?? '';
  const target = (run: () => void) => () => {
    splitView?.focus(paneId);
    run();
  };

  const named = paneLabel(paneId);

  return [
    {
      // A session, not a pane. The pane is the box; the name belongs to the terminal in it.
      label: named.label === '' ? 'Name session' : 'Rename session',
      // A group of its own: naming a terminal and marking a place in it are the same kind of
      // act, and neither belongs with the clipboard or with closing things.
      separated: true,
      run: () => {
        splitView?.focus(paneId);
        const pane = panesHost?.get(paneId);
        if (!pane || !workspaceId) return;
        openLabelForm({
          container: pane.element,
          placeholder: 'Name this session',
          current: named.label,
          recents: recentColors.title,
          ...(named.color ? { currentColor: named.color } : {}),
          // Drawn as it is typed. Only in this tab: nothing is sent until Save, so an abandoned
          // form leaves no trace anywhere else and Escape genuinely cancels.
          onPreview: (label, color) => splitView?.previewLabel(paneId, label, color),
          onSubmit: (label, color) => {
            document.querySelector('.pane-label-form')?.remove();
            if (label !== '') useColor('title', color);
            client?.send({ t: 'set-pane-label', workspaceId, paneId, label, color });
          },
          onCancel: () => {
            document.querySelector('.pane-label-form')?.remove();
            // Put back whatever the name actually is, since the preview only ever drew here.
            splitView?.previewLabel(paneId, named.label, named.color ?? '');
          },
        });
      },
    },
    {
      /**
       * A toggle, belonging to the session rather than to the tab.
       *
       * A tab can hold several terminals and one can be moved to a tab of its own later, so the
       * setting follows the terminal that finishes commands. A notification is for when you are
       * in another application; this is for when you are in another tab.
       */
      label: 'Flash the tab when a command finishes',
      enabled: session !== '',
      checked: flashing.has(session),
      run: () => {
        const on = !flashing.has(session);
        if (on) flashing.add(session);
        else flashing.delete(session);
        void setFlashing(session, on);
        if (!on) tabFlasher.stop();
      },
    },
    {
      // A landmark to scroll back to. Printed into the output rather than typed at the shell,
      // so it cannot run in whatever program is in the foreground.
      label: 'Add a marker here',
      enabled: session !== '',
      run: () => {
        splitView?.focus(paneId);
        const pane = panesHost?.get(paneId);
        if (!pane) return;
        openLabelForm({
          container: pane.element,
          placeholder: 'What is this marker for',
          current: '',
          recents: recentColors.marker,
          currentColor: recentColors.marker[0] ?? DEFAULT_COLOR.marker,
          onSubmit: (label, color) => {
            document.querySelector('.pane-label-form')?.remove();
            useColor('marker', color);
            client?.send({ t: 'insert-marker', sessionId: pane.sessionId, label, color });
          },
          onCancel: () => document.querySelector('.pane-label-form')?.remove(),
        });
      },
    },
    { label: 'Split right', separated: true, run: target(() => splitFocused('horizontal')) },
    { label: 'Split down', run: target(() => splitFocused('vertical')) },
    {
      label: 'Move to its own tab',
      enabled: hasSiblings,
      run: target(() => detachFocused()),
    },
    {
      /**
       * The same panel as Command+K and the button in the corner.
       *
       * Three ways to the same place, deliberately: a shortcut for people who know it, a button
       * for people who look, and a menu entry for people already in the menu.
       */
      label: 'Open menu',
      separated: true,
      run: () => commandPanel?.open(),
    },
    {
      // Reachable from the terminal as well as from the command menu and the toolbar icon.
      // A setting is usually wanted at the moment the thing it governs is annoying you.
      label: 'Settings',
      run: () => commandPanel?.openSettings(),
    },
    {
      /**
       * Always available, and with one pane it means the tab.
       *
       * Greying it out for the only pane was answering a question nobody asked. Somebody who
       * closes the only terminal in a tab means to be rid of the tab, and having to reach for
       * Chrome's own close for that is a seam where there should not be one.
       *
       * "Session", not "pane": the pane is the box, and what closing it gets rid of is the
       * terminal in it.
       */
      label: 'Close session',
      run: target(() => (hasSiblings ? closeFocused() : window.close())),
    },
    {
      // Distinct from closing: this ends the process rather than the view of it. Offered
      // because a pane holding something runaway is exactly when somebody wants it gone and
      // does not want to go looking for where that lives.
      label: 'Kill session',
      danger: true,
      enabled: session !== '',
      run: () => {
        if (session) client?.send({ t: 'kill-session', sessionId: session });
      },
    },
  ];
}

/**
 * Every pane, workspace, and session action, reachable by typing.
 *
 * This is the primary surface, not a duplicate of a control bar. A thirteen-button strip is
 * something you have to remember the layout of; a searchable list is something you can describe.
 * The hints are the keystroke where one exists, so the palette teaches the shortcut rather than
 * replacing it. See docs/06-chrome-integration.md.
 */
function paletteActions(): PaletteAction[] {
  const paneCount = layout ? collectPanes(layout).length : 1;
  const actions: PaletteAction[] = [
    { id: 'split-right', title: 'Split right', hint: '⌘D', run: () => splitFocused('horizontal') },
    { id: 'split-down', title: 'Split down', hint: '⇧⌘D', run: () => splitFocused('vertical') },
    {
      id: 'agent-tab',
      title: 'Launch an agent in a new tab',
      hint: '⇧⌘A',
      run: () => launchAgent('new-tab'),
    },
    {
      id: 'agent-split',
      title: 'Launch an agent beside this pane',
      run: () => launchAgent('split'),
    },
    {
      id: 'new-terminal',
      title: 'New terminal tab',
      hint: '⌥⇧T',
      run: () => {
        void chrome.tabs.create({ url: chrome.runtime.getURL('terminal.html'), active: true });
      },
    },
  ];

  // Actions that need more than one pane are omitted rather than shown disabled. A palette
  // offering something that does nothing is worse than a shorter palette.
  if (paneCount > 1) {
    actions.push(
      { id: 'close-pane', title: 'Close this pane', hint: '⌘W', run: () => closeFocused() },
      { id: 'detach-pane', title: 'Move this pane to its own tab', run: () => detachFocused() },
      {
        id: 'maximize',
        title: 'Maximize this pane',
        hint: 'Esc restores',
        run: () => splitView?.toggleMaximize(splitView.focused),
      },
      {
        id: 'merge',
        title: 'Pull a terminal in from another tab',
        run: () => {
          client?.send({ t: 'list-mergeable', workspaceId });
          palette?.openMerge();
        },
      },
    );
  } else {
    actions.push({
      id: 'merge',
      title: 'Pull a terminal in from another tab',
      run: () => {
        client?.send({ t: 'list-mergeable', workspaceId });
        palette?.openMerge();
      },
    });
  }

  actions.push(
    {
      id: 'focus-mode',
      title: 'Fullscreen focus mode',
      hint: 'gives this pane ⌘W',
      run: () => {
        const paneId = splitView?.focused;
        if (paneId) void splitView?.enterFocusMode(paneId);
      },
    },
    {
      id: 'clear-history',
      title: 'Clear command history',
      run: () => client?.send({ t: 'clear-history' }),
    },
    {
      id: 'shortcuts',
      title: 'Change keyboard shortcuts',
      hint: 'chrome://extensions/shortcuts',
      run: () => {
        void chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
      },
    },
  );
  return actions;
}

let commandPanel: CommandPanel | null = null;

/**
 * Timing for this tab, built from the events the page already receives.
 *
 * Per page rather than per daemon: "this session" means the terminal in front of you, and a
 * figure covering every tab you have open would answer a question nobody asked.
 */
const sessionStats = new SessionStats();

/**
 * The command panel, and the button that opens it.
 *
 * Its position and last tab are remembered in extension storage rather than in the database:
 * they are properties of a view, not of the data, and they should differ per machine.
 */
function buildCommandPanel(): void {
  const overlay = document.getElementById('overlays') as HTMLElement;

  /**
   * Opened from the toolbar icon's settings entry.
   *
   * Done here, right after the panel exists, rather than when the daemon reports something. It
   * was previously attached to a message that only arrives when a session is closed, so the
   * entry opened a tab and did nothing, which is exactly what it looked like.
   */
  const openSettingsIfAsked = (): void => {
    if (openPanelAt !== 'settings') return;
    /**
     * The start screen **stays**.
     *
     * It used to be dismissed here, which left a bare shell in the home directory behind the
     * settings panel. Closing the panel then dropped you into a terminal you never asked for,
     * in a directory you were not working in. A tab opened from the toolbar icon is a new tab
     * like any other, and a new tab shows the ways to begin.
     */
    commandPanel?.openSettings();
  };

  commandPanel = new CommandPanel({
    root: overlay,
    onPaste: (text) => sendToFocusedPane(text),
    // Return runs it; Command+Return copies it instead, for when it needs editing first.
    onRun: (text) => sendToFocusedPane(`${text}\r`),
    onCopy: (text) => void navigator.clipboard.writeText(text),
    canScrollTo: (command) => findCommandRow(command) !== null,
    onScrollTo: (command) => {
      const row = findCommandRow(command);
      // A command is worth a little context above it, the same as a landmark.
      if (row !== null) panesHost?.get(splitView?.focused ?? '')?.controller.scrollTo(row - 2);
    },
    onSearch: (query) => {
      const sessionId = focusedSessionId();
      client?.send({
        t: 'list-history',
        query,
        scope: 'global',
        limit: 100,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onKeep: (text) => client?.send({ t: 'save-item', title: text.slice(0, 60), body: text }),
    onStar: (entry) =>
      client?.send({ t: 'save-item', title: entry.command.slice(0, 60), body: entry.command }),
    onEdit: (id, changes) => client?.send({ t: 'update-saved', id, ...changes }),
    onDelete: (id) => client?.send({ t: 'delete-saved', id }),
    onCreate: (fields) => client?.send({ t: 'save-item', title: fields.title, body: fields.body }),
    onClose: () => {
      // The terminal takes the keyboard back, and its cursor starts blinking again.
      root.classList.remove('panel-has-keyboard');
      panesHost?.focus(splitView?.focused ?? '');
    },
    onOpen: () => {
      // Blurring the terminal is what stops its cursor: a blinking caret in a pane that is not
      // listening says the opposite of what is true.
      root.classList.add('panel-has-keyboard');
      panesHost?.blurAll();
    },
    onPlacement: (placement) => {
      void chrome.storage.local.set({ 'tabterm.panel': placement });
    },
    actions: () => paletteActions(),
    settings: () =>
      buildSettings({
        onChangeTheme: applyTheme,
        notify: () => notifyPolicy,
        onChangeNotify: (policy) => client?.send({ t: 'set-notify-policy', policy }),
        agentHooks: () => agentHooks,
        onChangeAgentHooks: (enabled) => client?.send({ t: 'set-agent-hooks', enabled }),
        backgroundTimeout: () => backgroundTimeout,
        onChangeBackgroundTimeout: (seconds) =>
          client?.send({ t: 'set-background-timeout', seconds }),
        scrollbackBytes: () => scrollbackBytes,
        onChangeScrollback: (bytes) => client?.send({ t: 'set-scrollback-budget', bytes }),
        shellIntegration: () => shellIntegration,
        onChangeShellIntegration: (enabled) =>
          client?.send({ t: 'set-shell-integration', enabled }),
      }),
    stats: () => buildStats(sessionStats),
  });

  openSettingsIfAsked();

  void chrome.storage.local.get('tabterm.panel').then((stored) => {
    const placement = (stored['tabterm.panel'] as PanelPlacement | undefined) ?? DEFAULT_PLACEMENT;
    commandPanel?.setPlacement(placement);
  });

  document.getElementById('cmd-button')?.addEventListener('click', () => {
    commandPanel?.toggle();
  });
}

/**
 * Paint both halves, and tell the other tabs.
 *
 * The interface follows CSS variables on the root. The terminal is drawn on a canvas by the
 * renderer and takes its colors from xterm's own theme object, which no stylesheet can reach, so
 * every open pane is repainted directly. Setting `data-theme` alone was the entire previous
 * implementation, and nothing anywhere read it.
 *
 * Storage is also the delivery mechanism: every tab watches the key, so changing the theme in
 * one repaints all of them without a message of our own.
 */
function applyTheme(theme: string): void {
  const chosen = themeNamed(theme);
  document.documentElement.dataset['theme'] = theme;
  for (const [name, value] of Object.entries(chosen.surface)) {
    document.documentElement.style.setProperty(name, value);
  }
  for (const pane of panesHost?.all ?? []) pane.controller.applyTheme(chosen.terminal);
  void chrome.storage.local.set({ 'tabterm.theme': theme });
}

/**
 * Follow the theme wherever it is changed.
 *
 * A setting changed in one tab has to reach the others: they are all the same product and a
 * preference that only applies where it was typed is not a preference. `chrome.storage` already
 * broadcasts, so watching the key costs nothing and needs no protocol.
 */
function watchTheme(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next: unknown = changes['tabterm.theme']?.newValue;
    if (typeof next !== 'string') return;
    if (document.documentElement.dataset['theme'] === next) return;
    applyTheme(next);
  });
  void chrome.storage.local.get('tabterm.theme').then((stored) => {
    applyTheme((stored['tabterm.theme'] as string | undefined) ?? DEFAULT_THEME);
  });
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
      // Command+Z takes back a clear, but only while one is being offered.
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'z' && undoClearIfOffered()) {
        e.preventDefault();
        return;
      }
      // Command+K toggles the command panel. Chrome does not reserve it and no shell needs it.
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        commandPanel?.toggle();
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
        case 'p':
          // The palette. It had Command+K until the command panel took that key, and a surface
          // reachable only by mouse is not a command palette, so it moved here rather than
          // sharing. Shift+Command+P is what every other editor uses for the same thing.
          palette?.toggle();
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
  lastStatus = s;
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
      /**
       * A session for a different workspace usually belongs in a new tab.
       *
       * Not when the start screen is showing. That tab is empty by definition: its own shell has
       * never been used, it is displaying a list of ways to begin, and choosing one of them
       * plainly means "begin here". Opening a second tab left the chosen layout somewhere else
       * and this tab still sitting on the menu, which looked like the layout had failed.
       */
      /**
       * Asked for from this tab's start screen, so it belongs in this tab.
       *
       * The flag rather than asking whether the start screen is showing, because choosing a
       * layout dismisses it immediately and the daemon's answer arrives after that.
       */
      const wanted = layoutRequestedHere;
      layoutRequestedHere = false;
      if (!wanted && attached && workspaceId && msg.workspaceId !== workspaceId) {
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

      // The panes a template asked for now exist, so its commands can be typed into them.
      if (pendingTemplate) {
        const template = pendingTemplate;
        pendingTemplate = null;
        msg.panes.forEach((pane, index) => {
          const command = template.commands[index]?.trim();
          // No trailing return: the command is left at the prompt for a person to run.
          const target = panesHost?.get(pane.paneId);
          if (command && target) client?.write(target.streamId, new TextEncoder().encode(command));
        });
      }
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
      /**
       * A pane left this tab on purpose, so open the tab that now owns it, **next to this one**.
       *
       * At the end of the strip it reads as an unrelated tab that happened to appear. Beside the
       * tab it came out of, it reads as the thing that just moved, which is what happened. Chrome
       * puts a tab at the end unless it is given an index.
       */
      const url = chrome.runtime.getURL(`terminal.html?workspace=${msg.newWorkspaceId}`);
      void chrome.tabs.getCurrent().then((here) => {
        void chrome.tabs.create({
          url,
          active: true,
          ...(here?.index === undefined ? {} : { index: here.index + 1 }),
        });
      });
      client?.send({ t: 'attach-workspace', workspaceId, cols: 80, rows: 24 });
      return;
    }

    case 'workspace-taken-over': {
      // This tab's session is alive in another tab now, so there is nothing here to show and
      // nothing to restore. Closing is the honest outcome, and it is what keeps the rule that a
      // session is never open in two places from leaving an empty tab behind.
      if (msg.workspaceId === workspaceId) {
        attached = false;
        window.close();
      }
      return;
    }

    case 'mergeable-sessions': {
      mergeable = [...msg.sessions];
      palette?.setMergeable(mergeable);
      for (const chooser of paneChoosers.values()) chooser.setSessions(mergeable);
      return;
    }

    case 'snapshot': {
      const pane = panesHost?.paneForStream(msg.snapshot.streamId);
      if (pane) panesHost?.restore(pane.paneId, msg.snapshot.screen);
      // A leftover partial-line marker above the first prompt. See `tidyPartialLine`.
      if (pane) tidyPartialLine(pane.paneId);
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
      // The panel is about to be drawn, so the terminal gives up the top of the window.
      /**
       * Drawn for a new tab. For a reattach, only once we know the tab is empty.
       *
       * A reattaching tab has nothing on screen until its snapshot arrives, so asking whether
       * it is empty before then always answers yes: the start screen appeared, the snapshot
       * landed, and it was taken away again half a second later. That flash is the bug. The
       * answer is not to decide faster but to not decide until there is something to decide on.
       */
      if ((!reattaching || startScreenDecided) && launcher && !launcher.dismissed) {
        root.classList.add('panel-open');
        refitAllPanes();
      }
      launcher?.setState(msg.state);
      launcherHome = msg.state.home;
      savedItems = [...msg.state.saved];
      palette?.setSaved(savedItems);
      commandPanel?.setFavorites(savedItems);
      // Asked for alongside launcher state, so the chips are there when the panel first draws.
      client?.send({ t: 'list-resumable', limit: 5 });
      client?.send({ t: 'list-servers' });
      client?.send({ t: 'get-memory-mode' });
      client?.send({ t: 'get-notify-policy' });
      client?.send({ t: 'get-agent-hooks' });
      client?.send({ t: 'get-shell-integration' });
      client?.send({ t: 'get-scrollback-budget' });
      client?.send({ t: 'get-background-timeout' });
      client?.send({ t: 'list-live-sessions' });
      // Templates live in extension storage rather than the daemon: they are about how somebody
      // likes to start work, not about anything the daemon owns.
      void loadTemplates().then((saved) => launcher?.setTemplates(saved));
      client?.send({ t: 'list-restorable' });
      return;
    }

    case 'server-detected': {
      showServerOffer(msg.port);
      // The dashboard, if it is on screen, should gain the row rather than wait to be reopened.
      client?.send({ t: 'list-servers' });
      return;
    }

    case 'notify-policy': {
      notifyPolicy = msg.policy;
      commandPanel?.refreshSettings();
      return;
    }

    case 'agent-hooks': {
      agentHooks = msg.status;
      commandPanel?.refreshSettings();
      return;
    }

    case 'folder-checked': {
      launcher?.folderChecked(msg);
      return;
    }

    case 'path-completion': {
      // One channel, two possible askers. The pane that asked last owns the answer.
      const chooser = completingPane ? paneChoosers.get(completingPane) : undefined;
      completingPane = null;
      if (chooser) chooser.setListing(msg.partial, msg.matches);
      else launcher?.pathCompletion(msg);
      return;
    }

    case 'live-sessions': {
      /**
       * Everything except what this tab is already showing.
       *
       * The panes in front of you are not news, and counting them is what made the list say
       * five when four of them were elsewhere. The daemon cannot make this cut because it is
       * the same list for every tab, so the tab that knows its own panes makes it.
       */
      const mine = new Set((panesHost?.all ?? []).map((p) => p.sessionId));
      launcher?.setLiveSessions(msg.sessions.filter((s) => !mine.has(s.sessionId)));
      // The counts, once they are known. The confirmation is already on screen by now.
      if (openPanelAt === 'reset') showResetConfirmation(msg.sessions);
      return;
    }

    case 'reset-done': {
      document.body.replaceChildren(buildResetDone(msg.sessionsEnded, msg.restarting));
      void chrome.runtime.sendMessage({ t: 'tabterm:close-other-terminals' });
      if (msg.restarting) void chrome.runtime.sendMessage({ t: 'tabterm:reload-extension' });
      return;
    }

    case 'background-timeout': {
      backgroundTimeout = msg.seconds;
      commandPanel?.refreshSettings();
      return;
    }

    case 'scrollback-budget': {
      scrollbackBytes = msg.bytes;
      commandPanel?.refreshSettings();
      return;
    }

    case 'shell-integration': {
      shellIntegration = msg.status;
      commandPanel?.refreshSettings();
      return;
    }

    case 'memory-mode': {
      memorySettings = msg;
      panesHost?.setScrollback(msg.scrollbackLines);
      // A mode that only took effect on the next tab would not help the machine it was chosen
      // for, so it is applied to what is already open.
      if (document.visibilityState === 'hidden') scheduleRendererRelease();
      return;
    }

    case 'restorable-workspaces': {
      launcher?.setRestorable(msg.workspaces);
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
      commandPanel?.setRecent(msg.entries);
      return;
    }

    case 'save-rejected': {
      // A refused hotstring has to be seen. Believing an abbreviation is set when it never
      // fires is worse than being told why it was not accepted.
      lastSaveRejection = msg.reason;
      setStatus(msg.reason, 'warn');
      setTimeout(() => setStatus('', 'hidden'), 4000);
      return;
    }

    case 'saved-updated': {
      savedItems = [...msg.saved];
      palette?.setSaved(savedItems);
      commandPanel?.setFavorites(savedItems);
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
      dismissClearUndo();
      sessionStats.begin(msg.sessionId, msg.command, msg.startedAt);
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
        const started = timeStateFor(pane.paneId).commandStartedAt;
        sessionStats.end(
          msg.sessionId,
          started === undefined ? 0 : msg.completedAt - started,
          msg.exitCode,
        );
      }
      if (pane) {
        const state = timeStateFor(pane.paneId);
        const startedAt = state.commandStartedAt;
        const longEnough = startedAt !== undefined && isLongRunning(startedAt);
        if (startedAt !== undefined) state.lastDurationMs = msg.completedAt - startedAt;
        else delete state.lastDurationMs;
        state.lastFinishedAt = msg.completedAt;
        if (msg.exitCode === undefined) delete state.lastExitCode;
        else state.lastExitCode = msg.exitCode;
        delete state.commandStartedAt;

        paneStatus.finished(pane.paneId, msg.exitCode);
        setFavicon(paneStatus.effective());
        // Asked for on this session, so the tab says so until somebody notices.
        if (flashing.has(msg.sessionId)) tabFlasher.start();
        /**
         * The panel is live while it is open.
         *
         * Its lists were fetched when it opened and never again, so a command run in the
         * terminal behind it did not appear until it was closed and reopened, and the stats it
         * was showing were the stats as of whenever somebody last pressed Command+K.
         */
        commandPanel?.refreshLive();
        refreshTitle();
        renderTimeLabels();

        // Only a command that ran long enough for someone to have looked away is worth a
        // status line. A fast one finished before they could miss it.
        if (longEnough) {
          const summary = describeTime({
            ...(state.lastDurationMs !== undefined ? { lastDurationMs: state.lastDurationMs } : {}),
            lastFinishedAt: msg.completedAt,
            ...(msg.exitCode !== undefined ? { lastExitCode: msg.exitCode } : {}),
          });
          setStatus(
            `${state.lastCommand ?? 'Command'} ${summary}`,
            msg.exitCode === undefined || msg.exitCode === 0 ? 'ok' : 'warn',
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
      /**
       * An error about a workspace concerns the tab showing that workspace, and nobody else.
       *
       * The daemon tells every client when a workspace ends, because the tab that needs to hear
       * it is not necessarily attached at that moment. This ignored the context entirely, so
       * one workspace ending put "this terminal session expired" over every open tab, including
       * ones whose own session was alive and running.
       */
      if (msg.context !== undefined && msg.context !== '' && msg.context !== workspaceId) return;

      if (msg.code === 'session-expired' || msg.code === 'session-not-found') {
        showRecovery('This terminal session expired.');
      } else {
        setStatus(describeError(msg.code, msg.message), 'error');
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
      /** What is selected, which the WebGL renderer paints on a canvas nothing can query. */
      selection: () => string;
      /** What the daemon said could be resumed, before the launcher trims it for display. */
      resumable: () => { sessionId: string; cwd: string; agent: string; summary?: string }[];
      /**
       * Drop the socket without closing the tab, which is what a discarded tab, a slept
       * machine and a dead service worker all look like from the daemon.
       */
      setTheme: (name: string) => void;
      terminalTheme: () => { background?: string } | undefined;
      dropConnection: () => void;
      reconnect: () => void;
      setBackgroundTimeout: (seconds: number | null) => void;
      /** Highlights on the focused pane. A decoration is painted, so the DOM cannot be asked. */
      highlights: () => { text: string; occurrence: number; color: string }[];
      /** Print a landmark, and read where the view is, without going through the menu. */
      insertMarker: (label: string, color?: string) => void;
      viewportY: () => number;
      /** Landmarks the focused pane can see. */
      markers: () => readonly { row: number; color: number }[];
      scrollToLine: (row: number) => void;
      /** Name a pane without going through its menu. */
      setPaneLabel: (paneId: string, label: string, color?: string) => void;
      /** Cell geometry, so a test can aim a real mouse event at a known character. */
      geometry: () => {
        cols: number;
        rows: number;
        left: number;
        top: number;
        cellWidth: number;
        cellHeight: number;
      } | null;
      /** End every session in this tab, so a test does not abandon them. */
      endSessions: () => void;
      workspaceId: () => string;
      paneIds: () => string[];
      attached: () => boolean;
      split: (direction: 'horizontal' | 'vertical') => void;
      closePane: () => void;
      detachPane: () => void;
      launchAgent: (where: 'new-tab' | 'split') => void;
      saveItem: (body: string, title?: string) => void;
      /** Bytes xterm has handed us, for diagnosing an input path that looks dead. */
      inputSeen: () => number;
      /** Stream bindings and socket state, for diagnosing input that goes nowhere. */
      transport: () => string;
      /** Drive input through the same path a keystroke takes, without a synthetic key event. */
      sendInput: (paneId: string, data: string) => void;
      savedItems: () => readonly SavedItem[];
      lastSaveRejection: () => string;
      deleteSaved: (id: string) => void;
      updateSaved: (
        id: string,
        changes: { title?: string; body?: string; hotstring?: string | null },
      ) => void;
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
    geometry: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      const screen = pane?.element.querySelector('.xterm-screen');
      if (!pane || !screen) return null;
      const rect = screen.getBoundingClientRect();
      return {
        cols: pane.controller.term.cols,
        rows: pane.controller.term.rows,
        left: rect.left,
        top: rect.top,
        cellWidth: rect.width / pane.controller.term.cols,
        cellHeight: rect.height / pane.controller.term.rows,
      };
    },
    selection: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.term.getSelection() ?? '';
    },
    setTheme: (name) => applyTheme(name),
    terminalTheme: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.term.options.theme;
    },
    dropConnection: () => client?.close(),
    reconnect: () => client?.connect(),
    setBackgroundTimeout: (seconds) => client?.send({ t: 'set-background-timeout', seconds }),
    resumable: () =>
      resumableSessions.map((r) => ({
        sessionId: r.sessionId,
        cwd: r.cwd,
        agent: r.agent,
        ...(r.summary === undefined ? {} : { summary: r.summary }),
      })),
    highlights: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return [...(pane?.controller.highlights ?? [])];
    },
    insertMarker: (label, color) => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      if (!pane) return;
      client?.send({
        t: 'insert-marker',
        sessionId: pane.sessionId,
        label,
        ...(color === undefined ? {} : { color }),
      });
    },
    markers: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.markers ?? [];
    },
    scrollToLine: (row) => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      pane?.controller.term.scrollToLine(row);
    },
    viewportY: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.term.buffer.active.viewportY ?? -1;
    },
    setPaneLabel: (paneId, label, color) => {
      if (!workspaceId) return;
      client?.send({
        t: 'set-pane-label',
        workspaceId,
        paneId,
        label,
        ...(color === undefined ? {} : { color }),
      });
    },
    /**
     * End every session in this tab. For tests, which would otherwise abandon them.
     *
     * Sessions survive a daemon restart now, so a test run that opened twenty terminals and walked
     * away left twenty shells running forever. Measured: 468 abandoned sessions after a week.
     */
    endSessions: () => {
      for (const pane of panesHost?.all ?? []) {
        if (pane.sessionId) client?.send({ t: 'kill-session', sessionId: pane.sessionId });
      }
    },
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
    inputSeen: () => inputBytesSeen,
    transport: () =>
      JSON.stringify({
        panes: (panesHost?.all ?? []).map((p) => ({
          paneId: p.paneId.slice(0, 8),
          sessionId: p.sessionId.slice(0, 8),
          streamId: p.streamId,
        })),
        status: lastStatus,
      }),
    sendInput: (paneId, data) => {
      const pane = panesHost?.get(paneId);
      if (pane) client?.write(pane.streamId, new TextEncoder().encode(data));
    },
    savedItems: () => savedItems,
    lastSaveRejection: () => lastSaveRejection,
    deleteSaved: (id) => client?.send({ t: 'delete-saved', id }),
    updateSaved: (id, changes) => client?.send({ t: 'update-saved', id, ...changes }),
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

  // Read once, so the first right-click already shows the color that was last used.
  refreshRecentColors();
  refreshFlashing();
  loadHiddenResumes();
  // Before anything is drawn, so a tab never flashes the wrong theme on the way in.
  watchTheme();
  buildHosts();
  buildLauncher();
  buildCommandPanel();
  installTestHook();
  installModifierTracking();
  installShortcuts();
  installAmbientFocus();
  // A reattached session gets the whole window from the start. Nothing about it is new, so
  // there is nothing to offer.
  /**
   * A reattach keeps its terminal, **unless the terminal has nothing in it**.
   *
   * The URL gains a workspace as soon as a session is created, so refreshing a tab that was
   * still showing the start screen looked exactly like reattaching to real work and dropped the
   * person into a bare shell in their home directory. A tab showing an untouched shell has not
   * begun, whatever its URL says, so the decision is made from the screen rather than the URL.
   *
   * Deferred until the snapshot has been applied, because until then every pane is empty and
   * the question cannot be answered.
   */
  if (reattaching) {
    setTimeout(() => {
      startScreenDecided = true;
      // Empty after the snapshot means the tab really has nothing in it, and the start screen
      // is what belongs there. Anything else keeps its terminal.
      if (thisTabIsUnused()) launcher?.show();
      else launcher?.dismiss();
    }, 900);
  }
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
    port: await daemonPort(),
    token,
    clientId: await connectionId(),
    role: 'data',
    onControl,
    onOutput: (streamId, data) => {
      panesHost?.write(streamId, data, (bytes) => client?.ack(streamId, bytes));
    },
    onStatus: statusFor,
    onProtocolError: (detail) => {
      // Said out loud rather than logged. A tab that quietly stops updating is the worst
      // possible failure, because nothing distinguishes it from a session with nothing to say.
      setStatus(`TabTerm hit a problem: ${detail}`, 'error');
    },
  });
  client.connect();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearTimeout(rendererTimer);
      rendererTimer = undefined;
      panesHost?.restoreRenderers();
      if (splitView?.focused) panesHost?.focus(splitView.focused);
      /**
       * Looking at the tab is what clears an outcome.
       *
       * A tick that said a command finished has now done its job, and it goes back to idle so
       * the next one still means something. On a timer instead it would expire while nobody
       * was there to read it, which is the exact case it exists for.
       */
      if (paneStatus.seen()) refreshTitle();
      setFavicon(paneStatus.effective());
      startTimeTicking();
    } else {
      clearInterval(animTimer);
      animTimer = undefined;
      // Leave the icon on a full, steady frame rather than wherever the pulse happened to stop,
      // so a hidden tab reads as a state rather than as a moment.
      if (needsAttention(faviconState) && memorySettings.faviconWhileHidden) {
        applyFavicon(drawFavicon(faviconState, 3));
      }
      // A hidden tab throttles timers anyway, and nobody is reading the label.
      stopTimeTicking();
      scheduleRendererRelease();
    }
  });
}

/**
 * The reset confirmation draws before anything is connected.
 *
 * Waiting for the daemon to report its sessions first meant a blank page whenever the daemon was
 * unreachable, which is precisely the situation somebody reaches for a reset in. It draws now
 * with what it knows, and fills in the counts if they arrive.
 */
if (openPanelAt === 'reset') showResetConfirmation([]);

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
