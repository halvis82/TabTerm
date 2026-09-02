import { createServer, type Server } from 'node:http';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AUTH_TIMEOUT_MS,
  panes,
  CLOSE_POLICY_VIOLATION,
  PROTOCOL_VERSION,
  VERSION,
  ackFrame,
  controlFrame,
  decodeFrame,
  outputFrame,
  ProtocolError,
  type ClientMessage,
  type LayoutNode,
  type ServerErrorCode,
  type ServerMessage,
} from '@tabterm/shared';
import { authDelayMs, recordFailure, recordSuccess, verifyToken } from './auth.js';
import type { Config } from './config.js';
import { FlowController } from './flow-control.js';
import { debug, info, warn } from './log.js';
import { expandHome } from './complete-path.js';
import { plainText } from './plain-text.js';
import { markerBlock } from './marker-block.js';
import { openPath, resolvePaths } from './paths.js';
import { processCwd } from './process-cwd.js';
import type { LauncherData } from './launcher-data.js';
import {
  findProjectConfig,
  leftmostTemplatePane,
  templateCommandIndex,
  type ProjectTemplate,
} from './project-config.js';
import { trustAction, type ProjectTrust } from './project-trust.js';
import { listResumable } from './agent-sessions.js';
import { listCodexResumable } from './codex-sessions.js';
import {
  AGENT_EXECUTABLE,
  interleaveByAgent,
  resumeCommand,
  type AgentKind,
} from './agent-resume.js';
import { loginPath, resolveExecutable } from './login-path.js';
import { listeningPorts } from './server-detect.js';
import { applyMemoryMode, frontendSettings } from './memory-modes.js';
import type { RestoreStore } from './restore-store.js';
import type { OutputArchive } from './output-archive.js';
import type { PluginHost } from './plugin-api.js';
import type { ProjectIndex } from './project-index.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { Session, SessionManager } from './session-manager.js';
import type { LayoutShape, LiveSession, ResumableAgentSession } from '@tabterm/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';
import { agentHooksStatus, setAgentHooks } from './agent-hooks.js';
import { setShellIntegration, shellIntegrationStatus } from './shell-integration.js';
import { clampPolicy, decide, type Finished, type NotifyPolicy } from './notify-policy.js';
import { readUserSettings, updateUserSetting } from './user-settings.js';
import { clampBudget, DEFAULT_SCROLLBACK_BYTES, linesForBytes } from './scrollback-budget.js';
import { completePath } from './complete-path.js';

interface Client {
  id: string;
  socket: WebSocket;
  role: 'control' | 'data';
  authed: boolean;
  /** sessionId -> streamId, for the sessions this connection is rendering. */
  streams: Map<string, number>;
  byStream: Map<number, string>;
  flow: Map<string, FlowController>;
  nextStream: number;
}

/**
 * A trust decision names a file and its content, and nothing else. The template is irrelevant
 * to recording an answer, so recording one never needs to re-parse the file.
 */
const EMPTY_TEMPLATE: ProjectTemplate = { name: '', layout: null, commands: [] };

/** How long a restored tab may still be handed its merged-away session back. */
const MERGED_AWAY_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a peer gets to complete a close handshake before its socket is destroyed. */
const GRACEFUL_CLOSE_MS = 2000;

/** And how long the forced path waits for the server to finish once sockets are destroyed. */
const FORCED_CLOSE_MS = 2000;

/**
 * Terminal output as readable lines.
 *
 * Colors, cursor moves and mode switches are all meaningful to a terminal and noise in a
 * preview, so they are removed rather than rendered. Anything non-printable left over goes
 * too, because a stray control character in a preview reads as a rendering bug.
 */
/**
 * Resident memory for a session's process tree, from the operating system.
 *
 * The shell plus whatever it is running, which is the part TabTerm can actually measure. A tab
 * showing the session costs more on top, in a Chrome renderer, and that is deliberately not
 * added in: `chrome.processes` is not available outside the dev channel, so any total would be
 * a guess presented as a measurement.
 */
function memoryOf(pid: number): number {
  if (!pid) return 0;
  try {
    // Reading the whole tree, since a shell running a build is mostly the build.
    const out = execFileSync('ps', ['-o', 'rss=', '-g', String(pid)], {
      encoding: 'utf8',
      timeout: 500,
    });
    let kilobytes = 0;
    for (const line of out.split('\n')) {
      const value = Number(line.trim());
      if (Number.isFinite(value)) kilobytes += value;
    }
    return kilobytes * 1024;
  } catch {
    // A process that ended between the listing and the measurement.
    return 0;
  }
}

// Re-exported so existing importers of the server keep working.
export { plainText } from './plain-text.js';

/**
 * Keep a timeout usable in both directions.
 *
 * Null means forever, which is a real answer. Anything positive is clamped to at least a minute,
 * because a timeout shorter than the time it takes to switch tabs would delete sessions out from
 * under somebody still using them. Zero and negatives read as forever rather than as instant,
 * since the harmless interpretation of a bad stored value is the right one.
 */
/**
 * The tail of a session's history, from the file the PTY host wrote.
 *
 * Read here rather than asked of the host, because the interesting case is a session whose host
 * is gone too, which is exactly when a tab has nothing else left to show.
 */
function historyTail(sessionId: string, lines = 12): string[] {
  try {
    const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
    const path = join(paths.scrollback, `${safe}.log`);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path);
    // Only the end is ever wanted, and these files run to megabytes.
    const tail = raw.subarray(Math.max(0, raw.length - 64 * 1024)).toString('utf8');
    return plainText(tail).slice(-lines);
  } catch {
    return [];
  }
}

export function clampTimeout(seconds: number | null): number | null {
  if (seconds === null) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(24 * 60 * 60, Math.max(60, Math.floor(seconds)));
}

/**
 * The readable half of a thrown thing.
 *
 * A category is not a reason. "could not launch the agent" tells somebody nothing they can do
 * anything about, while the cause underneath it usually names the command that was missing or
 * the directory that was not there. The `Error:` prefix goes because it is noise in a sentence.
 */
/** The shell's own clear-and-redraw, and the pair that discards a line and submits it empty. */
const CTRL_L = String.fromCharCode(12);
const CTRL_U = String.fromCharCode(21);
const CARRIAGE_RETURN = String.fromCharCode(13);

export function causeOf(thrown: unknown): string {
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  return text.replace(/^Error:\s*/, '').trim() || 'no reason was given';
}

/**
 * Is that still a directory?
 *
 * Used wherever something is about to be offered as a place to work. A folder that has been
 * deleted since it was last used is not an option, and finding out by opening a terminal in it
 * is the worst way to be told.
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class DaemonServer {
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #config: Config;
  readonly #sessions: SessionManager;
  readonly #workspaces: WorkspaceStore;
  readonly #launcher: LauncherData;
  readonly #trust: ProjectTrust;
  readonly #projects: ProjectIndex;
  readonly #restore: RestoreStore;
  readonly #archive: OutputArchive;
  readonly #plugins: PluginHost;
  readonly #clients = new Set<Client>();
  #closing: Promise<void> | null = null;
  #notifyPolicy: NotifyPolicy = clampPolicy(
    readUserSettings()['notify'] as Partial<NotifyPolicy> | undefined,
  );
  /** When an agent hook last reported anything, which is how "installed" is told from "working". */
  #lastAgentEventAt: number | undefined;
  #scrollbackBytes: number = clampBudget(
    (readUserSettings()['scrollbackBytes'] as number | undefined) ?? DEFAULT_SCROLLBACK_BYTES,
  );
  /** Set by main, since only it holds the host client. Absent with the in-process fallback. */
  hostClear?: (sessionId: string) => void;
  hostBudget?: (bytes: number) => void;
  /** Set by main. Drops every history file and returns how many went. */
  #resetHistory?: () => number;
  #restart?: () => void;

  setResetHooks(hooks: { history: () => number; restart: () => void }): void {
    this.#resetHistory = hooks.history;
    this.#restart = hooks.restart;
  }

  constructor(
    config: Config,
    sessions: SessionManager,
    workspaces: WorkspaceStore,
    launcher: LauncherData,
    trust: ProjectTrust,
    projects: ProjectIndex,
    restore: RestoreStore,
    archive: OutputArchive,
    plugins: PluginHost,
  ) {
    this.#config = config;
    this.#sessions = sessions;
    this.#workspaces = workspaces;
    this.#launcher = launcher;
    this.#trust = trust;
    this.#projects = projects;
    this.#restore = restore;
    this.#archive = archive;
    this.#plugins = plugins;
    // A workspace is written the moment it is created, not only when it changes or when the
    // daemon stops cleanly.
    this.#workspaces.onCreate((workspace) => this.#persistWorkspace(workspace.id));
    this.#http = createServer((_req, res) => {
      res.writeHead(426);
      res.end('websocket only');
    });
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on('connection', (socket, req) => {
      // Origin is logged, never trusted. Any local process can forge it.
      this.#onConnection(socket, req.socket.remoteAddress ?? 'unknown', req.headers.origin);
    });
  }

  /** Loopback only. Never 0.0.0.0, never ::. See docs/05-security.md. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(this.#config.port, '127.0.0.1', () => {
        info('server.listening', { port: this.#config.port });
        resolve(this.#config.port);
      });
    });
  }

  /**
   * Every session, with the last lines of its screen.
   *
   * The preview is taken from the daemon's own terminal state rather than asked of a tab,
   * because the interesting sessions are exactly the ones no tab is showing.
   */
  #historyTail(sessionId: string): string[] {
    return historyTail(sessionId);
  }

  /**
   * The sessions worth telling someone about.
   *
   * Not every live session: a shell that has printed a prompt and nothing else is a session to
   * the daemon and an empty tab to the person who opened it. Listing those is what turns
   * "running now" into a list of things nobody recognizes, and it counts the tab you are
   * reading it in. A session enters this list when a command runs in it, and never leaves
   * while it is alive, so going idle again does not make it disappear.
   *
   * Sessions started with an explicit command are in from the start, since the command is the
   * whole reason they exist and it may still be running.
   */
  #liveSessions(): LiveSession[] {
    return this.#sessions.all
      .filter((s) => s.state !== 'exited' && s.state !== 'reaped')
      .filter((s) => s.hasRun === true || s.command !== undefined)
      .map((session) => {
        const workspace = this.#workspaces.findBySession(session.id);
        // The serialized screen carries the escape sequences that produced it, and a preview
        // showing "[?2004h" beside a prompt looks like a bug in whatever is displaying it.
        const lines = plainText(session.vt.snapshot(0).screen);
        return {
          sessionId: session.id,
          memoryBytes: memoryOf(session.pid),
          ...(workspace ? { workspaceId: workspace.id } : {}),
          cwd: session.cwd,
          ...(session.titleFields.process ? { process: session.titleFields.process } : {}),
          ...(session.pendingCommand ? { lastCommand: session.pendingCommand } : {}),
          attached: session.clients.size > 0,
          startedAt: session.createdAt,
          preview: lines.slice(-6),
          busy: session.commandRunning,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get scrollbackBytes(): number {
    return this.#scrollbackBytes;
  }

  get notifyPolicy(): NotifyPolicy {
    return this.#notifyPolicy;
  }

  /** An agent hook fired. Recorded so the settings switch can say whether it is really working. */
  recordAgentEvent(at: number): void {
    this.#lastAgentEventAt = at;
  }

  /**
   * Something finished. Notify only if the policy says it was worth it.
   *
   * The threshold lives here rather than in the page because the duration is authoritative here
   * and because a discarded tab has nothing left to make the decision with.
   */
  notifyFinished(event: Finished, where?: string, target?: { workspaceId?: string }): void {
    const decision = decide(event, this.#notifyPolicy, where);
    if (!decision) return;
    this.broadcast({
      t: 'notify',
      priority: decision.priority,
      title: decision.title,
      body: decision.body,
      ...(target ? { target } : {}),
      ...(this.#notifyPolicy.onlyWhenUnfocused ? { suppressIfVisible: true } : {}),
    });
  }

  /**
   * Raise something for the user's attention.
   *
   * Goes only to control connections, because a terminal page may be hidden or already
   * discarded and cannot be relied on to deliver anything. See ADR-0003.
   */
  notify(
    priority: 'critical' | 'important' | 'low',
    title: string,
    body: string,
    target?: { workspaceId?: string; paneId?: string },
  ): void {
    this.broadcast({ t: 'notify', priority, title, body, ...(target ? { target } : {}) });
  }

  /**
   * To the control connection only.
   *
   * That is the offscreen document, and it is the right audience for things only it can act on:
   * a desktop notification, for instance, which no terminal page can raise.
   */
  broadcast(message: ServerMessage): void {
    for (const c of this.#clients) {
      if (c.authed && c.role === 'control') send(c.socket, controlFrame(message));
    }
  }

  /**
   * To every connection, including terminal pages.
   *
   * Shared state that pages render belongs here. Sending it to the control role alone means the
   * one context that cannot draw anything gets the update and every context that can does not,
   * which presents as a change simply not appearing: a favorite edited in one tab stayed stale
   * in all of them, and a page asking for the memory mode never heard back.
   */
  broadcastAll(message: ServerMessage): void {
    for (const c of this.#clients) {
      if (c.authed) send(c.socket, controlFrame(message));
    }
  }

  notifySession(session: Session, message: ServerMessage): void {
    for (const c of this.#clients) {
      if (c.authed && c.streams.has(session.id)) send(c.socket, controlFrame(message));
    }
  }

  /**
   * Stop serving, and actually finish doing it.
   *
   * `http.Server.close()` only calls back once every connection has gone, and a WebSocket whose
   * peer never completes the close handshake never goes. A discarded Chrome tab does exactly
   * that. The listener is released immediately either way, so the symptom is not a port that
   * stays bound: it is a process that has stopped serving and will not exit, which then blocks
   * launchd from starting its replacement. That happened for six days before it was noticed.
   *
   * So: ask nicely, then insist.
   */
  async close(): Promise<void> {
    // Idempotent. Shutdown is reached from a signal handler, from tests, and from an error
    // path, and a second call used to never return at all: closing an already-closed http
    // server never invokes the callback. A latent trap, and exactly the kind that only shows up
    // while something else is already going wrong.
    if (this.#closing) return this.#closing;
    this.#closing = this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    for (const c of this.#clients) c.socket.close(1001, 'daemon shutting down');

    // Give peers a moment to answer the close frame, so a well-behaved client gets a clean
    // disconnect rather than a destroyed socket.
    const closed = (async () => {
      await new Promise<void>((r) => this.#wss.close(() => r()));
      await new Promise<void>((r) => this.#http.close(() => r()));
    })();

    const graceful = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), GRACEFUL_CLOSE_MS).unref()),
    ]);
    if (graceful) return;

    // Somebody did not answer. Destroy what is left and then wait for the close to actually
    // complete: resolving here without that would be a lie, and the caller's next move is
    // usually to bind the same port.
    for (const c of this.#clients) {
      try {
        c.socket.terminate();
      } catch {
        /* already gone */
      }
    }
    this.#clients.clear();
    try {
      this.#http.closeAllConnections();
    } catch {
      /* already fully closed */
    }

    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, FORCED_CLOSE_MS).unref())]);
  }

  #onConnection(socket: WebSocket, source: string, origin: string | undefined): void {
    const client: Client = {
      id: 'unauthenticated',
      socket,
      role: 'data',
      authed: false,
      streams: new Map(),
      byStream: new Map(),
      flow: new Map(),
      nextStream: 1,
    };
    this.#clients.add(client);
    debug('client.connected', { source, origin });

    // Nothing is processed before auth-ok, and auth must arrive inside the window.
    const authTimer = setTimeout(() => {
      if (!client.authed) {
        warn('client.auth.timeout', { source });
        socket.close(CLOSE_POLICY_VIOLATION, 'auth-timeout');
      }
    }, AUTH_TIMEOUT_MS);

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      void isBinary;
      try {
        this.#onMessage(client, toBuffer(raw), source, authTimer);
      } catch (e) {
        if (e instanceof ProtocolError) {
          warn('protocol.error', { code: e.code });
          socket.close(CLOSE_POLICY_VIOLATION, e.code);
        } else {
          warn('client.error', { error: String(e) });
          sendError(socket, 'internal', 'internal error');
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      for (const sessionId of client.streams.keys()) {
        const s = this.#sessions.get(sessionId);
        if (!s) continue;
        // Capture where the session ended up before letting go of it. This is the last moment
        // before it might expire, and it is what a recovery screen will have to work with.
        void this.#liveCwd(s).catch(() => {
          /* best effort */
        });
        this.#sessions.detach(s, client.id);
      }
      for (const f of client.flow.values()) f.dispose();
      this.#clients.delete(client);
      // Its report about tabs went with it: a browser that has gone does not speak for them.
      this.#sessions.forgetReporter(client.id);
      debug('client.disconnected', { clientId: client.id });
    });
  }

  #onMessage(client: Client, raw: Buffer, source: string, authTimer: NodeJS.Timeout): void {
    const frame = decodeFrame(raw);

    if (!client.authed) {
      if (frame.kind !== 'control' || frame.message.t !== 'auth') {
        recordFailure(source);
        client.socket.close(CLOSE_POLICY_VIOLATION, 'auth-required');
        return;
      }
      const msg = frame.message;
      if (msg.v !== PROTOCOL_VERSION) {
        send(client.socket, controlFrame({ t: 'auth-fail', code: 'version-unsupported' }));
        client.socket.close(CLOSE_POLICY_VIOLATION, 'version-unsupported');
        return;
      }
      if (!verifyToken(msg.token)) {
        recordFailure(source);
        // Delay the rejection rather than refusing future connections: on loopback the source
        // address cannot tell the real extension from a hostile process, so refusing would
        // lock out the legitimate client. See docs/05-security.md.
        setTimeout(() => {
          send(client.socket, controlFrame({ t: 'auth-fail', code: 'auth-failed' }));
          client.socket.close(CLOSE_POLICY_VIOLATION, 'auth-failed');
        }, authDelayMs(source));
        return;
      }
      clearTimeout(authTimer);
      recordSuccess(source);
      client.authed = true;
      client.id = msg.clientId;
      client.role = msg.role;
      info('client.authenticated', { clientId: client.id, role: client.role });
      send(
        client.socket,
        controlFrame({
          t: 'auth-ok',
          serverVersion: VERSION,
          sessionCount: this.#sessions.all.length,
        }),
      );
      return;
    }

    switch (frame.kind) {
      case 'control':
        this.#onControl(client, frame.message as ClientMessage);
        return;
      case 'input': {
        const sessionId = client.byStream.get(frame.streamId);
        const session = sessionId ? this.#sessions.get(sessionId) : undefined;
        if (session) this.#sessions.write(session, Buffer.from(frame.data));
        return;
      }
      case 'ack': {
        const sessionId = client.byStream.get(frame.streamId);
        if (sessionId) client.flow.get(sessionId)?.ack(frame.bytesConsumed);
        return;
      }
      case 'output':
        // Clients never send output frames.
        client.socket.close(CLOSE_POLICY_VIOLATION, 'unexpected-output-frame');
        return;
    }
  }

  #onControl(client: Client, msg: ClientMessage): void {
    /* eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check --
       Deliberately partial: unimplemented control messages fall through to the default arm
       and are logged, so protocol growth does not break an older daemon. */
    switch (msg.t) {
      case 'auth':
        return; // Already authenticated. Idempotent, ignore.

      case 'create-session': {
        const session = this.#sessions.create({
          cols: msg.cols,
          rows: msg.rows,
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          ...(msg.command ? { command: msg.command } : {}),
        });
        // Every session lives in a workspace, even a lone one. That is what makes splitting
        // and detaching operations on one model rather than special cases.
        const { workspace } = this.#workspaces.create(session.id);
        const streamId = this.#bind(client, session);
        send(
          client.socket,
          controlFrame({
            t: 'session-created',
            sessionId: session.id,
            streamId,
            pid: session.pid,
            workspaceId: workspace.id,
          }),
        );
        this.#attach(client, session, streamId, msg.cols, msg.rows);
        return;
      }

      case 'attach-workspace': {
        const workspace = this.#workspaces.get(msg.workspaceId);
        if (workspace) {
          this.#attachWorkspace(client, msg.workspaceId, msg.cols, msg.rows);
          return;
        }

        // The workspace is gone. If its session was merged into another tab and is still
        // alive, restoring this tab means the user wants it back here, so hand it back
        // rather than reporting an expiry. See docs/04-session-lifecycle.md §7.
        const moved = this.#mergedAway.get(msg.workspaceId);
        const session = moved ? this.#sessions.get(moved.sessionId) : undefined;
        if (moved && session) {
          const host = this.#workspaces.findBySession(moved.sessionId);
          if (host) {
            const pane = this.#workspaces.paneFor(host, moved.sessionId);
            if (pane && panes(host.layout).length > 1) {
              this.#workspaces.detachToNewWorkspace(host.id, pane);
              this.#broadcastLayout(host.id);
            }
          }
          const revived = this.#workspaces.findBySession(moved.sessionId);
          this.#mergedAway.delete(msg.workspaceId);
          if (revived) {
            info('workspace.auto-detached', { restored: msg.workspaceId, into: revived.id });
            send(
              client.socket,
              controlFrame({
                t: 'pane-detached',
                workspaceId: msg.workspaceId,
                newWorkspaceId: revived.id,
              }),
            );
            return;
          }
        }

        sendError(client.socket, 'session-expired', 'no such workspace');
        return;
      }

      case 'split-pane': {
        const workspace = this.#workspaces.get(msg.workspaceId);
        if (!workspace) {
          sendError(client.socket, 'session-expired', 'no such workspace');
          return;
        }
        // A new pane inherits the directory of the pane it was split from, which is almost
        // always what someone wants when they open a second terminal beside their work.
        const sourceSessionId = this.#workspaces
          .sessionIds(workspace)
          .find((id) => this.#workspaces.paneFor(workspace, id) === msg.paneId);
        const source = sourceSessionId ? this.#sessions.get(sourceSessionId) : undefined;

        void (async () => {
          const cwd = msg.cwd ?? (source ? await this.#liveCwd(source) : undefined);
          const session = this.#sessions.create({
            cols: msg.cols,
            rows: msg.rows,
            ...(cwd ? { cwd } : {}),
            ...(msg.command ? { command: msg.command } : {}),
          });
          this.#workspaces.split(msg.workspaceId, msg.paneId, msg.direction, session.id);
          this.#attachWorkspace(client, msg.workspaceId, msg.cols, msg.rows);
          this.#broadcastLayout(msg.workspaceId);
        })().catch((e: unknown) => {
          warn('workspace.split.failed', { error: String(e) });
          sendError(client.socket, 'internal', causeOf(e));
        });
        return;
      }

      case 'close-pane': {
        const workspace = this.#workspaces.get(msg.workspaceId);
        if (!workspace) return;
        const sessionId = this.#workspaces
          .sessionIds(workspace)
          .find((id) => this.#workspaces.paneFor(workspace, id) === msg.paneId);
        this.#workspaces.closePane(msg.workspaceId, msg.paneId);
        if (sessionId) {
          const session = this.#sessions.get(sessionId);
          if (session) void this.#sessions.kill(session);
        }
        this.#broadcastLayout(msg.workspaceId);
        return;
      }

      case 'insert-marker': {
        const session = this.#sessions.get(msg.sessionId);
        if (!session) return;
        this.#sessions.inject(
          session,
          markerBlock({
            label: msg.label,
            ...(msg.color === undefined ? {} : { color: msg.color }),
            cols: session.vt.cols,
          }),
        );
        /**
         * And leave a prompt under it.
         *
         * The marker is printed where the cursor was, so the shell's prompt ends up above it
         * and the next command is typed against a bare line. Discarding the line and submitting
         * an empty one is what pressing Enter at a prompt does, and it makes the shell print a
         * fresh prompt beneath the marker.
         *
         * Only when nothing is running: those two characters would otherwise be input to
         * whatever program is in the foreground.
         */
        if (!session.commandRunning) {
          this.#sessions.write(session, Buffer.from(CTRL_U + CARRIAGE_RETURN, 'utf8'));
        }
        return;
      }

      case 'set-pane-label': {
        const updated = this.#workspaces.setLabel(
          msg.workspaceId,
          msg.paneId,
          msg.label,
          msg.color,
        );
        if (updated) this.#broadcastLayout(msg.workspaceId);
        return;
      }

      case 'check-folder':
      case 'create-folder': {
        const wanted = expandHome(msg.path.trim());
        void (async () => {
          if (msg.t === 'create-folder') {
            try {
              await mkdir(wanted, { recursive: true });
            } catch (e: unknown) {
              send(
                client.socket,
                controlFrame({
                  t: 'folder-checked',
                  path: msg.path,
                  exists: false,
                  error: causeOf(e),
                }),
              );
              return;
            }
          }
          // Asked about the text as typed, and answered with the same text, so an answer that
          // arrives after another keystroke can be recognized as stale rather than shown.
          let exists = false;
          let isFile = false;
          try {
            const info = await stat(wanted);
            exists = info.isDirectory();
            isFile = !info.isDirectory();
          } catch {
            // Not there, which is the answer rather than a failure.
          }
          send(
            client.socket,
            controlFrame({
              t: 'folder-checked',
              path: msg.path,
              exists,
              ...(isFile ? { isFile } : {}),
            }),
          );
        })().catch(() => {
          /* answering is best effort; the box simply shows nothing */
        });
        return;
      }

      case 'tabs-open': {
        /**
         * What Chrome actually has open, which is the only trustworthy answer to "is anybody
         * still using this?".
         *
         * Accepted from any client. The extension's control connection is the one that sends
         * it, and a report that arrives from anywhere else can only ever say that more tabs
         * exist, which is the safe direction.
         */
        this.#sessions.reportOpenWorkspaces(client.id, msg.workspaceIds);
        return;
      }

      case 'list-mergeable': {
        const here = this.#workspaces.get(msg.workspaceId);
        const mine = new Set(here ? this.#workspaces.sessionIds(here) : []);
        const list = this.#workspaces.all.flatMap((w) =>
          this.#workspaces.sessionIds(w).flatMap((sessionId) => {
            if (mine.has(sessionId)) return [];
            const session = this.#sessions.get(sessionId);
            if (!session) return [];
            return [
              {
                sessionId,
                workspaceId: w.id,
                title: session.titleFields.process ?? session.shell.split('/').pop() ?? 'shell',
                cwd: session.cwd,
                paneCount: panes(w.layout).length,
                attached: session.clients.size > 0,
                hasRun: session.hasRun === true,
              },
            ];
          }),
        );
        send(client.socket, controlFrame({ t: 'mergeable-sessions', sessions: list }));
        return;
      }

      case 'merge-into': {
        try {
          const sourceBefore = this.#workspaces.findBySession(msg.sessionId);
          const sourceId = sourceBefore?.id;

          const { source } = this.#workspaces.mergeInto(
            msg.workspaceId,
            msg.targetPaneId,
            msg.sessionId,
            msg.direction,
          );

          // Whoever was rendering the source workspace needs to hear about it. If the merge
          // took its last pane, the workspace is gone and that tab has nothing left to show.
          if (source) this.#broadcastLayout(source.id);
          else if (sourceId) {
            // Its last pane left, so the workspace is gone. Remember where the session went,
            // so restoring that tab can pull it back instead of reporting an expiry.
            this.#mergedAway.set(sourceId, { sessionId: msg.sessionId, at: Date.now() });
            this.#pruneMergedAway();
            // Taken over, not expired. The tab it left can close rather than offering to
            // restore a session that is alive in another tab.
            this.#tellEveryone({
              t: 'workspace-taken-over',
              workspaceId: sourceId,
              sessionId: msg.sessionId,
            });
            this.#notifyWorkspaceGone(sourceId);
          }
          this.#attachWorkspace(client, msg.workspaceId, 80, 24);
          this.#broadcastLayout(msg.workspaceId);
        } catch (e) {
          warn('workspace.merge.failed', { error: String(e) });
          sendError(client.socket, 'session-attached-elsewhere', 'could not merge that session');
        }
        return;
      }

      case 'detach-pane-to-tab': {
        const before = this.#workspaces.get(msg.workspaceId);
        const leavingSession = before
          ? panes(before.layout).find((p) => p.paneId === msg.paneId)?.sessionId
          : undefined;

        const result = this.#workspaces.detachToNewWorkspace(msg.workspaceId, msg.paneId);
        if (!result) {
          sendError(client.socket, 'workspace-invalid-layout', 'cannot detach the only pane');
          return;
        }

        // Release this client's hold on the departing session. Without this the client still
        // looks attached, so a later attach skips it as already-bound and never sends the
        // snapshot, leaving a blank pane.
        if (leavingSession) {
          const session = this.#sessions.get(leavingSession);
          if (session) this.#sessions.detach(session, client.id);
          this.#unbind(client, leavingSession);
        }

        send(
          client.socket,
          controlFrame({
            t: 'pane-detached',
            workspaceId: msg.workspaceId,
            newWorkspaceId: result.newWorkspace.id,
          }),
        );
        if (result.source) this.#broadcastLayout(result.source.id);
        return;
      }

      case 'set-ratio': {
        if (!this.#workspaces.get(msg.workspaceId)) return;
        this.#workspaces.setRatio(msg.workspaceId, msg.paneId, msg.ratio);
        this.#broadcastLayout(msg.workspaceId, client);
        return;
      }

      case 'swap-panes': {
        if (!this.#workspaces.get(msg.workspaceId)) return;
        this.#workspaces.swap(msg.workspaceId, msg.a, msg.b);
        this.#broadcastLayout(msg.workspaceId);
        return;
      }

      case 'resize-pane': {
        const workspace = this.#workspaces.get(msg.workspaceId);
        if (!workspace) return;
        const sessionId = this.#workspaces
          .sessionIds(workspace)
          .find((id) => this.#workspaces.paneFor(workspace, id) === msg.paneId);
        const session = sessionId ? this.#sessions.get(sessionId) : undefined;
        if (session) this.#sessions.resize(session, client.id, msg.cols, msg.rows);
        return;
      }

      case 'attach': {
        const id = msg.sessionId;
        if (!id) {
          sendError(client.socket, 'session-not-found', 'attach requires a sessionId');
          return;
        }
        const session = this.#sessions.get(id);
        if (!session) {
          sendError(client.socket, 'session-expired', 'no such session');
          return;
        }
        const streamId = client.streams.get(id) ?? this.#bind(client, session);
        this.#attach(client, session, streamId, msg.cols, msg.rows);
        return;
      }

      case 'detach': {
        const session = this.#sessions.get(msg.sessionId);
        if (session) this.#sessions.detach(session, client.id);
        this.#unbind(client, msg.sessionId);
        return;
      }

      case 'resize': {
        const session = this.#sessions.get(msg.sessionId);
        if (session) this.#sessions.resize(session, client.id, msg.cols, msg.rows);
        return;
      }

      case 'kill-session': {
        const session = this.#sessions.get(msg.sessionId);
        if (session) void this.#sessions.kill(session);
        return;
      }

      case 'set-persistence': {
        const session = this.#sessions.get(msg.sessionId);
        if (session) this.#sessions.setPersistent(session, true);
        return;
      }

      case 'set-pin': {
        if (!msg.sessionId) return;
        const session = this.#sessions.get(msg.sessionId);
        if (session) this.#sessions.setPinned(session, msg.pinned);
        return;
      }

      case 'resolve-paths': {
        const session = this.#sessions.get(msg.sessionId);
        if (!session) return;
        void (async () => {
          const cwd = await this.#liveCwd(session);
          const results = await resolvePaths(msg.candidates, cwd);
          send(
            client.socket,
            controlFrame({ t: 'paths-resolved', sessionId: session.id, results, cwd }),
          );
        })().catch(() => {
          /* resolution is best effort; a failure just leaves paths unclickable */
        });
        return;
      }

      case 'open-path': {
        // Re-resolve rather than trusting the path the frontend sends back. The frontend is
        // ours, but this keeps the trust boundary at the daemon where it belongs.
        const session = this.#sessions.get(msg.sessionId);
        if (!session) return;
        void this.#liveCwd(session)
          .then((cwd) => resolvePaths([msg.path], cwd))
          .then(async ([resolved]) => {
            if (!resolved?.exists) {
              sendError(client.socket, 'path-not-found', 'no such path');
              return;
            }

            // Shift-click opens a terminal where the file lives, which is a session rather
            // than a spawn, so the daemon does it rather than delegating to `open`.
            if (msg.how === 'new-terminal') {
              const dir = resolved.isDirectory
                ? resolved.absolute
                : resolved.absolute.slice(0, resolved.absolute.lastIndexOf('/')) || '/';
              const spawned = this.#sessions.create({ cwd: dir, cols: 80, rows: 24 });
              const { workspace } = this.#workspaces.create(spawned.id);
              this.#launcher.recordDir(dir);
              send(
                client.socket,
                controlFrame({
                  t: 'session-created',
                  sessionId: spawned.id,
                  streamId: 0,
                  pid: spawned.pid,
                  workspaceId: workspace.id,
                }),
              );
              return;
            }

            await openPath(resolved.absolute, msg.how, {
              editor: this.#config.editor,
              guiEditor: this.#config.guiEditor,
              line: resolved.line,
              column: resolved.column,
            });
          })
          .catch(() => {
            sendError(client.socket, 'path-not-found', 'could not open path');
          });
        return;
      }

      case 'launch-agent': {
        void (async () => {
          // Inherit the directory of the pane it was launched from, which is nearly always
          // the project someone wants the agent to look at.
          let cwd = msg.cwd;
          if (!cwd && msg.workspaceId && msg.paneId) {
            const ws = this.#workspaces.get(msg.workspaceId);
            const sessionId = ws
              ? panes(ws.layout).find((p) => p.paneId === msg.paneId)?.sessionId
              : undefined;
            const from = sessionId ? this.#sessions.get(sessionId) : undefined;
            if (from) cwd = await this.#liveCwd(from);
          }

          const session = this.#sessions.create({
            cols: msg.cols,
            rows: msg.rows,
            command: this.#config.agentCommand,
            ...(cwd ? { cwd } : {}),
          });
          if (cwd) this.#launcher.recordDir(cwd);

          if (msg.where === 'split' && msg.workspaceId && msg.paneId) {
            this.#workspaces.split(msg.workspaceId, msg.paneId, 'horizontal', session.id);
            this.#attachWorkspace(client, msg.workspaceId, msg.cols, msg.rows);
            this.#broadcastLayout(msg.workspaceId);
            return;
          }

          // A new native tab is the default, because that is the whole premise: an agent
          // session is a Chrome tab like any other. See docs/09-agent-integration.md §5.
          const { workspace } = this.#workspaces.create(session.id);
          send(
            client.socket,
            controlFrame({
              t: 'session-created',
              sessionId: session.id,
              streamId: 0,
              pid: session.pid,
              workspaceId: workspace.id,
            }),
          );
        })().catch((e: unknown) => {
          warn('agent.launch.failed', { error: String(e) });
          // The cause, not a category. "could not launch the agent" cannot be acted on; the
          // reason it could not usually names a missing command or an unreadable directory.
          sendError(client.socket, 'internal', causeOf(e));
        });
        return;
      }

      case 'list-launcher': {
        // Ask the OS where every live session actually is before answering. OSC 7 only reports
        // for users who sourced the shell integration, and recent folders should work for
        // everyone. This is event driven, triggered by opening a tab, not a poll.
        void Promise.all(
          this.#sessions.all.map(async (session) => {
            const cwd = await this.#liveCwd(session);
            this.#launcher.recordDir(cwd);
          }),
        )
          .then(() => this.#sendLauncherState(client))
          .catch(() => this.#sendLauncherState(client));
        return;
      }

      case 'recall-workspace': {
        const recalled = this.#launcher.recallWorkspace(msg.workspaceId);
        send(
          client.socket,
          controlFrame({
            t: 'workspace-recall',
            workspaceId: msg.workspaceId,
            found: recalled !== null,
            ...(recalled
              ? {
                  cwd: recalled.cwd,
                  lastSeenAt: recalled.lastSeenAt,
                  ...(recalled.lastCommand ? { lastCommand: recalled.lastCommand } : {}),
                  ...(recalled.sessionId
                    ? { lastScreen: this.#historyTail(recalled.sessionId) }
                    : {}),
                }
              : {}),
          }),
        );
        return;
      }

      case 'list-history': {
        // A scope is resolved from the session the user is looking at, not from anything the
        // page asserts, so "this project" always means the project they are actually in.
        const scope = msg.scope ?? 'global';
        const session = msg.sessionId ? this.#sessions.get(msg.sessionId) : undefined;
        const limit = msg.limit ?? 100;
        const offset = msg.offset ?? 0;
        const context = session
          ? {
              cwd: session.cwd,
              sessionId: session.id,
              ...(this.#projects.cached(session.cwd)?.root
                ? { gitRoot: this.#projects.cached(session.cwd)?.root as string }
                : {}),
            }
          : {};

        const entries = this.#launcher.search({
          query: msg.query ?? '',
          scope,
          context,
          limit,
          offset,
        });
        send(
          client.socket,
          controlFrame({
            t: 'history-page',
            entries,
            offset,
            hasMore: entries.length >= limit,
            appliedFilters: this.#launcher.lastApplied,
            scope,
          }),
        );
        return;
      }

      case 'update-saved': {
        const result = this.#launcher.updateSaved(msg.id, {
          ...(msg.title !== undefined ? { title: msg.title } : {}),
          ...(msg.body !== undefined ? { body: msg.body } : {}),
          ...(msg.hotstring !== undefined ? { hotstring: msg.hotstring } : {}),
        });
        if (!result.ok) {
          // Reported rather than swallowed: a refused hotstring is something the user has to
          // see, or they will believe an abbreviation is set that never fires.
          send(
            client.socket,
            controlFrame({ t: 'save-rejected', id: msg.id, reason: result.reason }),
          );
          return;
        }
        this.broadcastAll({ t: 'saved-updated', saved: this.#launcher.saved() });
        return;
      }

      case 'pin-saved': {
        this.#launcher.pinSaved(msg.id, msg.pinned);
        send(client.socket, controlFrame({ t: 'saved-updated', saved: this.#launcher.saved() }));
        return;
      }

      case 'save-item': {
        // Scoping is resolved from the session, so "this project" always means the repository
        // the user is actually in rather than one the page asserts.
        const scopeSession = msg.sessionId ? this.#sessions.get(msg.sessionId) : undefined;
        const scopeRoot =
          msg.scopeToProject === true && scopeSession
            ? this.#projects.cached(scopeSession.cwd)?.root
            : undefined;
        this.#launcher.save({
          ...(msg.kind ? { kind: msg.kind } : {}),
          title: msg.title,
          body: msg.body,
          ...(msg.tags ? { tags: msg.tags } : {}),
          ...(scopeRoot ? { gitRoot: scopeRoot } : {}),
        });
        send(client.socket, controlFrame({ t: 'saved-updated', saved: this.#launcher.saved() }));
        return;
      }

      case 'delete-saved': {
        this.#launcher.deleteSaved(msg.id);
        send(client.socket, controlFrame({ t: 'saved-updated', saved: this.#launcher.saved() }));
        return;
      }

      case 'use-saved': {
        this.#launcher.markUsed(msg.id);
        return;
      }

      case 'clear-history': {
        this.#launcher.clearHistory();
        send(
          client.socket,
          controlFrame({
            t: 'history-page',
            entries: [],
            offset: 0,
            hasMore: false,
            appliedFilters: [],
            scope: 'global',
          }),
        );
        return;
      }

      case 'pin-dir': {
        this.#launcher.pinDir(msg.path, msg.pinned);
        return;
      }

      case 'forget-dir': {
        this.#launcher.forgetDir(msg.path);
        return;
      }

      case 'create-layout': {
        void this.#createLayout(client, msg).catch((e: unknown) => {
          warn('layout.create.failed', { error: String(e) });
          sendError(client.socket, 'path-not-found', causeOf(e));
        });
        return;
      }

      case 'inspect-project': {
        void this.#inspectProject(client, msg.cwd).catch((e: unknown) => {
          warn('project.inspect.failed', { error: String(e) });
          send(client.socket, controlFrame({ t: 'project-config', cwd: msg.cwd, config: null }));
        });
        return;
      }

      case 'decide-project-trust': {
        // Recorded against the hash the user was actually shown. If the file changed between
        // the prompt and the answer, the stored decision simply will not match it next time.
        this.#trust.record(
          { path: msg.path, contentHash: msg.contentHash, template: EMPTY_TEMPLATE },
          msg.decision,
        );
        return;
      }

      case 'launch-project-template': {
        void this.#launchProjectTemplate(client, msg).catch((e: unknown) => {
          warn('project.launch.failed', { error: String(e) });
          sendError(client.socket, 'internal', causeOf(e));
        });
        return;
      }

      case 'list-resumable': {
        void this.#resumableSessions(msg.cwd, msg.limit ?? 8)
          .then((sessions) => {
            send(client.socket, controlFrame({ t: 'resumable-sessions', sessions }));
          })
          .catch(() => {
            // Discovery reads somebody else's file format. It failing means no offer, and
            // never an error the user has to think about.
            send(client.socket, controlFrame({ t: 'resumable-sessions', sessions: [] }));
          });
        return;
      }

      case 'resume-agent': {
        /**
         * Resuming is a spawn like any other. The id came from the store, but it is passed as
         * argv to the agent CLI and never through a shell.
         *
         * In **the session's own directory**, which the row carries. An agent resumed somewhere
         * else has different files in front of it, which for Claude is a different project
         * entirely and for Codex is a conversation about the wrong tree.
         */
        const agent: AgentKind = msg.agent ?? 'claude';
        const session = this.#sessions.create({
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          command: resumeCommand(agent, this.#agentExecutable(agent), msg.sessionId),
        });
        this.#launcher.recordDir(msg.cwd);
        const { workspace } = this.#workspaces.create(session.id);
        send(
          client.socket,
          controlFrame({
            t: 'session-created',
            sessionId: session.id,
            streamId: 0,
            pid: session.pid,
            workspaceId: workspace.id,
          }),
        );
        return;
      }

      case 'list-servers': {
        // One lsof across every live session, run because someone asked. Not a poll: a
        // dashboard nobody is looking at costs nothing.
        void listeningPorts(this.#sessions.all.map((session) => session.pid))
          .then((ports) => {
            const servers = this.#sessions.all
              .map((session) => {
                const port = ports.get(session.pid) ?? session.listeningPort;
                if (port === undefined) return null;
                session.listeningPort = port;
                const workspace = this.#workspaces.findBySession(session.id);
                return {
                  sessionId: session.id,
                  port,
                  cwd: session.cwd,
                  ...(workspace ? { workspaceId: workspace.id } : {}),
                  ...(session.titleFields.process ? { command: session.titleFields.process } : {}),
                  ...(session.commandStartedAt ? { startedAt: session.commandStartedAt } : {}),
                };
              })
              .filter((s): s is NonNullable<typeof s> => s !== null);
            send(client.socket, controlFrame({ t: 'server-list', servers }));
          })
          .catch(() => {
            send(client.socket, controlFrame({ t: 'server-list', servers: [] }));
          });
        return;
      }

      case 'stop-server': {
        const target = this.#sessions.get(msg.sessionId);
        if (!target) {
          sendError(client.socket, 'session-not-found', 'that terminal is gone');
          return;
        }
        // An interrupt, exactly what a person would type. Not a kill: the process gets to shut
        // down the way it was written to, and anything the shell owns is left alone.
        this.#sessions.write(target, Buffer.from('\u0003', 'utf8'));

        if (msg.restart === true) {
          const again = target.pendingCommand ?? this.#launcher.lastCommandIn(target.cwd);
          if (again) {
            // Long enough for the interrupt to land and the prompt to come back. Sending into
            // a shell that is still shutting down would type into the wrong place.
            setTimeout(() => {
              this.#sessions.write(target, Buffer.from(`${again}\r`, 'utf8'));
            }, 1200).unref();
          }
        }
        delete target.listeningPort;
        return;
      }

      case 'get-memory-mode':
      case 'set-memory-mode': {
        if (msg.t === 'set-memory-mode') {
          // Applied in place, to the live config object every subsystem already holds a
          // reference to. Reap timers read it when they next fire and scrollback is read on
          // the next write, so there is nothing to restart.
          Object.assign(this.#config, applyMemoryMode(this.#config, msg.mode));
          this.#sessions.applyScrollback(this.#config.scrollbackLines);
          info('memory-mode.changed', { mode: msg.mode });
        }
        const mode = this.#config.memoryMode;
        this.broadcastAll({ t: 'memory-mode', mode, ...frontendSettings(mode) });
        return;
      }

      case 'list-restorable': {
        const live = new Set(this.#workspaces.all.map((w) => w.id));
        /**
         * Only what could actually be reopened.
         *
         * A workspace whose directories have since been deleted cannot come back: every pane in
         * it would fail to spawn. Offering it is offering a button that produces an error, so a
         * saved workspace with no surviving directory is left out. One that has lost some of its
         * panes' directories is still offered, because the rest of it is real.
         */
        const workspaces = this.#restore
          .list(live)
          .map((entry) => ({
            workspaceId: entry.workspaceId,
            paneCount: entry.panes.length,
            savedAt: entry.savedAt,
            panes: entry.panes.map((pane) => ({
              cwd: pane.cwd,
              hadCommand: (pane.command?.length ?? 0) > 0,
              ...(pane.lastCommand ? { lastCommand: pane.lastCommand } : {}),
            })),
          }))
          .filter((entry) => entry.panes.some((pane) => existsSync(pane.cwd)));
        send(client.socket, controlFrame({ t: 'restorable-workspaces', workspaces }));
        return;
      }

      case 'forget-restorable': {
        this.#restore.forget(msg.workspaceId);
        return;
      }

      case 'restore-workspace': {
        try {
          this.#restoreWorkspace(client, msg);
        } catch (e: unknown) {
          warn('restore.failed', { error: String(e) });
          sendError(client.socket, 'internal', 'could not restore that workspace');
        }
        return;
      }

      case 'get-archive-status':
      case 'get-notify-policy':
      case 'set-notify-policy': {
        if (msg.t === 'set-notify-policy') {
          this.#notifyPolicy = clampPolicy({ ...this.#notifyPolicy, ...msg.policy });
          // Persisted, because a preference that does not survive a restart is not a preference.
          updateUserSetting('notify', this.#notifyPolicy);
          info('notify-policy.changed', { policy: this.#notifyPolicy });
        }
        this.broadcastAll({ t: 'notify-policy', policy: this.#notifyPolicy });
        return;
      }

      case 'complete-path': {
        const { completed, matches } = completePath(msg.partial);
        send(
          client.socket,
          controlFrame({ t: 'path-completion', partial: msg.partial, completed, matches }),
        );
        return;
      }

      case 'list-live-sessions': {
        send(client.socket, controlFrame({ t: 'live-sessions', sessions: this.#liveSessions() }));
        return;
      }

      case 'reset-everything': {
        /**
         * The button for when everything has gone wrong.
         *
         * Ends every session, drops every byte of history, and optionally replaces the daemon
         * itself. Nothing here is recoverable, which is why the interface confirms first and why
         * the reply says what actually happened rather than "ok".
         */
        const sessions = this.#sessions.all;
        const ended = sessions.length;
        for (const session of sessions) void this.#sessions.kill(session);
        const removed = this.#resetHistory?.() ?? 0;
        info('reset', { sessionsEnded: ended, historyFilesRemoved: removed });
        send(
          client.socket,
          controlFrame({
            t: 'reset-done',
            sessionsEnded: ended,
            historyFilesRemoved: removed,
            restarting: msg.restartDaemon,
          }),
        );
        if (msg.restartDaemon) {
          // Exiting non-zero is what asks launchd to replace this process, since the LaunchAgent
          // is KeepAlive{SuccessfulExit:false}. Delayed so the reply reaches the page first.
          setTimeout(() => this.#restart?.(), 400);
        }
        return;
      }

      case 'clear-scrollback': {
        const session = this.#sessions.get(msg.sessionId);
        if (!session) return;
        session.vt.clearScrollback();
        this.hostClear?.(msg.sessionId);
        // The saved screen too. A snapshot is what an expired tab offers to show you, and
        // offering back something the user cleared would be the same failure by another route.
        const workspace = this.#workspaces.findBySession(msg.sessionId);
        if (workspace) this.snapshotWorkspace(workspace.id);

        /**
         * Then ask the shell to redraw, so the screen looks like one that just ran `clear`.
         *
         * Purging the buffers alone left a genuinely empty screen with no prompt on it, which
         * is a state no shell ever produces and which leaves the next command typed against
         * nothing. Ctrl+L is the shell's own clear-and-redraw: it puts the prompt back at the
         * top, keeps whatever was half typed, and redraws a full-screen program correctly
         * instead of blanking it.
         */
        this.#sessions.write(session, Buffer.from(CTRL_L, 'utf8'));
        info('scrollback.cleared', { sessionId: msg.sessionId });
        return;
      }

      case 'get-background-timeout':
      case 'set-background-timeout': {
        if (msg.t === 'set-background-timeout') {
          this.#sessions.keepBackgroundSeconds = clampTimeout(msg.seconds);
          updateUserSetting('keepBackgroundSeconds', this.#sessions.keepBackgroundSeconds);
          // Applied to what is already detached, not only to what detaches next: a person who
          // just shortened this expects it to affect the sessions they were looking at.
          this.#sessions.rescheduleReaps();
          info('background-timeout.changed', { seconds: this.#sessions.keepBackgroundSeconds });
        }
        this.broadcastAll({
          t: 'background-timeout',
          seconds: this.#sessions.keepBackgroundSeconds,
        });
        return;
      }

      case 'get-scrollback-budget':
      case 'set-scrollback-budget': {
        if (msg.t === 'set-scrollback-budget') {
          this.#scrollbackBytes = clampBudget(msg.bytes);
          updateUserSetting('scrollbackBytes', this.#scrollbackBytes);
          // Lines are what a terminal counts, bytes are what a person budgets. The conversion
          // uses a measured average line, so the number in settings stays honest.
          this.#sessions.applyScrollback(linesForBytes(this.#scrollbackBytes));
          this.hostBudget?.(this.#scrollbackBytes);
          info('scrollback.budget', { bytes: this.#scrollbackBytes });
        }
        this.broadcastAll({ t: 'scrollback-budget', bytes: this.#scrollbackBytes });
        return;
      }

      case 'get-agent-hooks':
      case 'set-agent-hooks': {
        // Writing to somebody else's configuration file, so it happens only here, on an
        // explicit request, and never as a side effect of starting up.
        const status =
          msg.t === 'set-agent-hooks'
            ? setAgentHooks(msg.enabled, this.#lastAgentEventAt)
            : agentHooksStatus(this.#lastAgentEventAt);
        this.broadcastAll({ t: 'agent-hooks', status });
        return;
      }

      case 'get-shell-integration':
      case 'set-shell-integration': {
        // A live session emitting command marks proves the integration is working, which beats
        // reading the profile: it can be sourced from anywhere.
        const active = this.#sessions.all.some((s) => s.shellIntegration === true);
        const status =
          msg.t === 'set-shell-integration'
            ? setShellIntegration(msg.enabled, active)
            : shellIntegrationStatus(active);
        this.broadcastAll({ t: 'shell-integration', status });
        return;
      }

      case 'set-archive-enabled': {
        if (msg.t === 'set-archive-enabled') this.#archive.setEnabled(msg.enabled);
        const usage = this.#archive.usage();
        this.broadcastAll({
          t: 'archive-status',
          enabled: this.#archive.enabled,
          rows: usage.rows,
          bytes: usage.bytes,
        });
        return;
      }

      case 'search-output': {
        const results = this.#archive
          .search({
            ...(msg.query ? { query: msg.query } : {}),
            ...(msg.command ? { command: msg.command } : {}),
            limit: msg.limit ?? 25,
          })
          .map((r) => ({
            id: r.id,
            command: r.command,
            cwd: r.cwd,
            exitCode: r.exitCode,
            startedAt: r.startedAt,
            bytes: r.bytes,
            // A preview, not the whole thing. Sending megabytes of output to render a result
            // list would be the wrong trade every time.
            preview: r.output.slice(0, 400),
          }));
        send(client.socket, controlFrame({ t: 'output-results', results }));
        return;
      }

      case 'clear-output-archive': {
        this.#archive.clear();
        const usage = this.#archive.usage();
        this.broadcastAll({ t: 'archive-status', enabled: this.#archive.enabled, ...usage });
        return;
      }

      case 'list-sessions': {
        for (const s of this.#sessions.all) {
          send(
            client.socket,
            controlFrame({
              t: 'process-state',
              sessionId: s.id,
              state: s.state === 'exited' ? 'exited' : 'idle',
            }),
          );
        }
        return;
      }

      // Later phases add workspace, scrollback, and subscription messages. Unknown control
      // messages are logged rather than fatal, so an older daemon tolerates a newer client.
      default:
        debug('control.unhandled', { t: (msg as { t: string }).t });
    }
  }

  /**
   * Where the session actually is right now.
   *
   * OSC 7 is instant but requires the user to have sourced the shell integration. The OS
   * always knows, so it is the fallback, which makes path resolution work with no shell setup.
   */
  async #liveCwd(session: Session): Promise<string> {
    const fromOs = await processCwd(session.pid);
    if (fromOs) session.cwd = fromOs;

    // This is the one place the daemon reliably learns where a session really is, with or
    // without shell integration, so it is also where recovery metadata is kept current.
    // Without it an expired tab could only apologise instead of offering to reopen where you
    // were. See docs/04-session-lifecycle.md §8.
    const workspace = this.#workspaces.findBySession(session.id);
    this.#launcher.rememberSession({
      id: session.id,
      cwd: session.cwd,
      shell: session.shell,
      ...(workspace ? { workspaceId: workspace.id } : {}),
      ...(session.command ? { command: session.command } : {}),
    });

    return session.cwd;
  }

  /**
   * Attach every pane of a workspace at once.
   *
   * This is what makes a multi-pane tab restore: the client gets the layout plus a snapshot
   * per pane, so it can rebuild the whole thing rather than reconnecting one terminal.
   */
  #attachWorkspace(client: Client, workspaceId: string, cols: number, rows: number): void {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return;

    const entries: { paneId: string; sessionId: string; streamId: number }[] = [];
    const toAttach: { sessionId: string; streamId: number }[] = [];

    for (const { paneId, sessionId } of panes(workspace.layout)) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;

      // Only attach panes this client is not already rendering. Re-attaching an existing pane
      // would resend its snapshot, which resets the renderer and can discard output that
      // arrived mid-flight. Splitting one pane must not disturb its neighbors.
      const existing = client.streams.get(sessionId);
      if (existing !== undefined) {
        entries.push({ paneId, sessionId, streamId: existing });
        continue;
      }

      const streamId = this.#bind(client, session);
      entries.push({ paneId, sessionId, streamId });
      toAttach.push({ sessionId, streamId });
    }

    send(
      client.socket,
      controlFrame({
        t: 'workspace-attached',
        workspaceId,
        layout: workspace.layout,
        panes: entries,
      }),
    );

    // Sizes are per pane, so the client sends real ones once it has laid the panes out.
    for (const entry of toAttach) {
      const session = this.#sessions.get(entry.sessionId);
      if (session) this.#attach(client, session, entry.streamId, cols, rows);
    }
  }

  #broadcastLayout(workspaceId: string, except?: Client): void {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return;
    // Every layout change is also the moment the restore snapshot is worth updating. Saving on
    // the event rather than on a timer means a workspace that has not changed is never written.
    this.#persistWorkspace(workspaceId);
    for (const c of this.#clients) {
      if (c === except || !c.authed) continue;
      const holdsIt = this.#workspaces.sessionIds(workspace).some((id) => c.streams.has(id));
      if (holdsIt) {
        send(
          c.socket,
          controlFrame({ t: 'workspace-updated', workspaceId, layout: workspace.layout }),
        );
      }
    }
  }

  /**
   * Build a workspace of N panes, all rooted in one directory.
   *
   * The path is expanded and resolved here rather than in the frontend, because the frontend
   * cannot see the filesystem and a path typed by a human is untrusted input like any other.
   */
  /** Report what a directory declares, and what the user has already decided about it. */
  async #inspectProject(client: Client, cwd: string): Promise<void> {
    const target = expandPath(cwd);
    const loaded = target ? await findProjectConfig(target) : null;
    if (!loaded) {
      send(client.socket, controlFrame({ t: 'project-config', cwd, config: null }));
      return;
    }

    const state = this.#trust.evaluate(loaded);
    send(
      client.socket,
      controlFrame({
        t: 'project-config',
        cwd,
        config: {
          path: loaded.path,
          contentHash: loaded.contentHash,
          name: loaded.template.name,
          paneCount: Math.max(1, loaded.template.commands.length),
          // Verbatim, so the prompt shows exactly what would run.
          commands: loaded.template.commands,
          action: trustAction(state),
          ...(state.status === 'changed' && state.previousDecision
            ? { changedSince: state.previousDecision }
            : {}),
        },
      }),
    );
  }

  /**
   * Build the workspace a project declares.
   *
   * Reached only after an explicit trust decision, and re-checked here rather than taken on
   * the client's word: a compromised page must not be able to skip the prompt by sending this
   * message directly. See docs/05-security.md §5.
   */
  async #launchProjectTemplate(
    client: Client,
    msg: { cwd: string; cols: number; rows: number },
  ): Promise<void> {
    const target = expandPath(msg.cwd);
    if (!target) {
      sendError(client.socket, 'path-not-found', 'not a usable path');
      return;
    }
    const loaded = await findProjectConfig(target);
    if (!loaded) {
      sendError(client.socket, 'path-not-found', 'no project config there');
      return;
    }
    if (trustAction(this.#trust.evaluate(loaded)) !== 'offer') {
      // Not an error the user needs to see as a failure: it means the file changed, or was
      // never approved, and the honest answer is to ask again rather than to run it.
      sendError(client.socket, 'not-trusted', 'this project config has not been approved');
      return;
    }

    // A declared working directory is confined to the project. Letting a repository choose
    // any directory on the machine would turn a layout into a way to point commands at
    // someone else's files.
    const declared = loaded.template.cwd ? resolvePath(target, loaded.template.cwd) : null;
    const cwd =
      declared && (declared === target || declared.startsWith(`${target}/`)) ? declared : target;
    const commands = loaded.template.commands;
    const spawn = (index: number): Session =>
      this.#sessions.create({
        cwd,
        cols: msg.cols,
        rows: msg.rows,
        // argv straight through to execvp. Nothing in the file is ever handed to a shell.
        ...(commands[index]?.length ? { command: commands[index] } : {}),
      });

    const layout = loaded.template.layout;
    const first = spawn(layout ? templateCommandIndex(leftmostTemplatePane(layout)) : 0);
    const { workspace, paneId } = this.#workspaces.create(first.id);
    if (layout) this.#realizeTemplate(workspace.id, layout, paneId, spawn);

    this.#launcher.recordDir(cwd);
    info('project.launched', { path: loaded.path, panes: commands.length });
    send(
      client.socket,
      controlFrame({
        t: 'session-created',
        sessionId: first.id,
        streamId: 0,
        pid: first.pid,
        workspaceId: workspace.id,
      }),
    );
  }

  /**
   * Turn a declared tree into real panes.
   *
   * Splits are applied in place, so the pane that is already there becomes the left child and
   * each new session lands at the leftmost slot of the right child. That ordering is what
   * makes each declared command reach the pane it was written for.
   */
  #realizeTemplate(
    workspaceId: string,
    node: LayoutNode,
    hostPaneId: string,
    spawn: (index: number) => Session,
  ): void {
    if (node.type === 'terminal') return;

    const rightAnchor = leftmostTemplatePane(node.children[1]);
    const session = spawn(templateCommandIndex(rightAnchor));
    const { paneId: newPane } = this.#workspaces.split(
      workspaceId,
      hostPaneId,
      node.direction,
      session.id,
    );
    this.#workspaces.setRatio(workspaceId, hostPaneId, node.ratio);
    this.#realizeTemplate(workspaceId, node.children[0], hostPaneId, spawn);
    this.#realizeTemplate(workspaceId, node.children[1], newPane, spawn);
  }

  /**
   * Save what a workspace looks like right now.
   *
   * Public because shutdown needs it too: a clean stop is the one moment every screen is worth
   * capturing, and a machine restarting is exactly the case this exists for.
   */
  /**
   * Persist a workspace the moment it exists, and record which sessions belong to it.
   *
   * Both were previously written only on a layout change or a clean shutdown, which meant a
   * single pane workspace that was never split survived a stop and not a crash. Adoption after
   * a restart reads exactly these two things. See daemon/src/adopt.ts.
   */
  #persistWorkspace(workspaceId: string): void {
    this.snapshotWorkspace(workspaceId);
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return;
    for (const sessionId of this.#workspaces.sessionIds(workspace)) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      this.#launcher.rememberSession({
        id: session.id,
        cwd: session.cwd,
        shell: session.shell,
        workspaceId,
        ...(session.command ? { command: session.command } : {}),
      });
    }
  }

  snapshotWorkspace(workspaceId: string): void {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return;
    this.#restore.save(workspace, (sessionId) => {
      const session = this.#sessions.get(sessionId);
      if (!session) return null;
      return {
        cwd: session.cwd,
        screen: session.vt.snapshot(0).screen,
        ...(session.pendingCommand ? { lastCommand: session.pendingCommand } : {}),
        ...(session.command ? { command: session.command } : {}),
      };
    });
  }

  /** Snapshot every live workspace. Called on shutdown. */
  snapshotAll(): void {
    for (const workspace of this.#workspaces.all) this.snapshotWorkspace(workspace.id);
  }

  /**
   * Bring a workspace back after its processes are gone.
   *
   * The layout, the directories and the screens come back. The processes do not, and cannot:
   * a PTY dies with the machine. What is recreated is a fresh shell per pane, in the directory
   * that pane was in, showing what was on its screen before, with a line saying plainly that
   * it was restarted rather than resumed. Anything else would be a lie told by a terminal.
   *
   * Replaying the last command is opt-in per restore, because re-running whatever was last in
   * a pane is occasionally exactly right and occasionally destructive, and the daemon cannot
   * tell which. See docs/04-session-lifecycle.md §11.
   */
  #restoreWorkspace(
    client: Client,
    msg: { workspaceId: string; replayCommands: boolean; cols: number; rows: number },
  ): void {
    const saved = this.#restore.get(msg.workspaceId);
    if (!saved || saved.panes.length === 0) {
      sendError(client.socket, 'session-expired', 'nothing recorded for that workspace');
      return;
    }

    const ordered = [...saved.panes];
    const first = ordered[0];
    if (!first) return;

    const spawn = (pane: (typeof ordered)[number]): Session =>
      this.#sessions.create({
        cwd: pane.cwd,
        cols: msg.cols,
        rows: msg.rows,
        ...(pane.command?.length ? { command: pane.command } : {}),
      });

    const firstSession = spawn(first);
    const { workspace, paneId } = this.#workspaces.create(firstSession.id);
    const created: { session: Session; pane: (typeof ordered)[number] }[] = [
      { session: firstSession, pane: first },
    ];

    // Rebuilt as a chain of splits rather than by writing the old layout back, because the old
    // layout names session ids that no longer exist. The shape is preserved, the identities are
    // not, which is the honest thing to do when the processes are gone.
    let anchor = paneId;
    for (const pane of ordered.slice(1)) {
      const session = spawn(pane);
      const result = this.#workspaces.split(workspace.id, anchor, 'horizontal', session.id);
      anchor = result.paneId;
      created.push({ session, pane });
    }

    for (const { session, pane } of created) {
      // The screen as it was, then a line making clear this is not the same process. Written
      // into the VT state so it survives a reattach, and so it is part of what the pane is
      // rather than something drawn over it.
      const notice =
        `\r\n\x1b[2m[restored ${describeAge(pane.savedAt)}. ` +
        `This is a new shell in ${pane.cwd}, not the original process.]\x1b[0m\r\n`;
      session.vt.write(Buffer.from(pane.screen + notice, 'utf8'));

      if (msg.replayCommands && pane.lastCommand) {
        // Typed, not run. The command lands at the prompt and waits, so a destructive one is
        // seen before it happens. Opt-in twice over: the flag, and then Enter.
        setTimeout(() => {
          this.#sessions.write(session, Buffer.from(pane.lastCommand ?? '', 'utf8'));
        }, 900).unref();
      }
      this.#launcher.recordDir(pane.cwd);
    }

    info('restore.done', { from: msg.workspaceId, into: workspace.id, panes: created.length });
    // The old record is spent. Leaving it would offer the same restore forever.
    this.#restore.forget(msg.workspaceId);

    send(
      client.socket,
      controlFrame({
        t: 'session-created',
        sessionId: firstSession.id,
        streamId: 0,
        pid: firstSession.pid,
        workspaceId: workspace.id,
      }),
    );
  }

  async #createLayout(
    client: Client,
    msg: {
      path: string;
      panes: number;
      direction: 'horizontal' | 'vertical';
      shape?: LayoutShape;
      createIfMissing: boolean;
      cols: number;
      rows: number;
    },
  ): Promise<void> {
    const target = expandPath(msg.path);
    if (!target) {
      sendError(client.socket, 'path-not-found', 'not a usable path');
      return;
    }

    let usable = false;
    try {
      usable = (await stat(target)).isDirectory();
    } catch {
      if (msg.createIfMissing) {
        await mkdir(target, { recursive: true });
        usable = true;
      }
    }
    if (!usable) {
      sendError(client.socket, 'path-not-found', 'no such directory');
      return;
    }

    const count = Math.min(6, Math.max(1, Math.floor(msg.panes)));
    const first = this.#sessions.create({ cwd: target, cols: msg.cols, rows: msg.rows });
    const { workspace } = this.#workspaces.create(first.id);
    const rootPane = this.#workspaces.paneFor(workspace, first.id) as string;

    /** Another shell in the same directory, for a pane that is about to exist. */
    const spawn = (): string =>
      this.#sessions.create({ cwd: target, cols: msg.cols, rows: msg.rows }).id;
    const split = (pane: string, direction: 'horizontal' | 'vertical'): string =>
      this.#workspaces.split(workspace.id, pane, direction, spawn()).paneId;

    /**
     * Arrangements that repeated splitting cannot describe.
     *
     * One beside two stacked, and four in the corners, both need a particular pane split rather
     * than always the newest one. Everything else chains from the newest, which is what makes
     * three panes come out evenly rather than nested one deep.
     */
    if (msg.shape === 'one-plus-two') {
      const right = split(rootPane, 'horizontal');
      split(right, 'vertical');
    } else if (msg.shape === 'quad') {
      const right = split(rootPane, 'horizontal');
      split(rootPane, 'vertical');
      split(right, 'vertical');
    } else {
      let anchor = rootPane;
      for (let i = 1; i < count; i++) {
        anchor = split(anchor, msg.direction);
      }
    }

    this.#launcher.recordDir(target);
    send(
      client.socket,
      controlFrame({
        t: 'session-created',
        sessionId: first.id,
        streamId: 0,
        pid: first.pid,
        workspaceId: workspace.id,
      }),
    );
  }

  /**
   * Workspaces whose last pane was merged elsewhere, and where it went.
   *
   * Chrome cannot be told to forget a closed tab, so restoring one of these URLs is normal.
   * The session is alive and visible in another tab, and the right response is to hand it
   * back rather than to claim it expired. See docs/04-session-lifecycle.md §7.
   */
  readonly #mergedAway = new Map<string, { sessionId: string; at: number }>();

  /**
   * Forget merge records nobody came back for.
   *
   * The timestamp was always stored and never read, which is the signature of pruning that was
   * intended and not written. An entry is small, but one per merge with no expiry is still a
   * map that only grows, and the tab it refers to stopped existing long ago.
   */
  #pruneMergedAway(): void {
    const cutoff = Date.now() - MERGED_AWAY_TTL_MS;
    for (const [workspaceId, record] of this.#mergedAway) {
      if (record.at < cutoff) this.#mergedAway.delete(workspaceId);
    }
  }

  /**
   * Send to every authenticated client, terminal pages included.
   *
   * `broadcast` reaches only the control connection, which is the offscreen document, and a
   * message meant for the tab showing a workspace has to reach the tab.
   */
  /**
   * Which executable to run for an agent.
   *
   * A configured `agentCommand` wins for the agent it names, so somebody whose `claude` is a
   * wrapper script keeps their wrapper. The other agent falls back to its usual name.
   */
  #agentExecutable(agent: AgentKind): string {
    const configured = this.#config.agentCommand[0];
    if (configured !== undefined && configured.endsWith(agent)) return configured;
    return AGENT_EXECUTABLE[agent];
  }

  /**
   * Conversations that could actually be picked back up.
   *
   * Both stores, merged and newest first, and then **filtered down to what would work**. A row
   * that errors when pressed is worse than no row: it costs the same click and teaches nobody
   * anything. Three things are checked here, none of which the store knows:
   *
   * 1. The CLI is reachable. The daemon runs under launchd with a four-directory PATH, so an
   *    agent installed in a home directory is not on it; the login shell's PATH is used instead.
   *    Without this, every row for a missing CLI was an offer to run a command not found.
   * 2. The directory still exists. Resuming into a deleted project is an immediate failure for
   *    Claude and a conversation about a missing tree for Codex.
   * 3. The store said which conversation it is. Handled inside each reader.
   */
  async #resumableSessions(
    cwd: string | undefined,
    limit: number,
  ): Promise<ResumableAgentSession[]> {
    const path = loginPath();
    const usable = (agent: AgentKind): boolean =>
      resolveExecutable(this.#agentExecutable(agent), path) !== null;

    const knownDirs = this.#launcher.recentDirs(40).map((d) => d.path);
    const [claude, codex] = await Promise.all([
      usable('claude')
        ? listResumable({ ...(cwd ? { cwd } : {}), knownDirs, limit })
        : Promise.resolve([]),
      usable('codex')
        ? listCodexResumable({ ...(cwd ? { cwd } : {}), limit })
        : Promise.resolve([]),
    ]);

    const merged = interleaveByAgent<ResumableAgentSession>([
      ...claude.map((s) => ({ ...s, agent: 'claude' as const })),
      ...codex.map((s) => ({ ...s, agent: 'codex' as const })),
    ]);

    const offerable: ResumableAgentSession[] = [];
    for (const session of merged) {
      if (offerable.length >= limit) break;
      // Checked here rather than at the reader, so both stores get the same guarantee.
      if (!(await directoryExists(session.cwd))) continue;
      offerable.push(session);
    }
    return offerable;
  }

  #tellEveryone(message: ServerMessage): void {
    for (const c of this.#clients) {
      if (c.authed) send(c.socket, controlFrame(message));
    }
  }

  /** Tell anyone rendering a workspace that it no longer exists. */
  #notifyWorkspaceGone(workspaceId: string): void {
    for (const c of this.#clients) {
      if (!c.authed) continue;
      send(
        c.socket,
        controlFrame({
          t: 'error',
          code: 'session-expired',
          message: 'workspace closed',
          context: workspaceId,
        }),
      );
    }
  }

  #sendLauncherState(client: Client): void {
    send(
      client.socket,
      controlFrame({
        t: 'launcher-state',
        state: {
          recentDirs: this.#launcher.recentDirs(),
          saved: this.#launcher.saved(),
          // Whatever loaded from ~/.config/tabterm/plugins. With none installed this is empty
          // and the launcher renders no plugin section at all.
          plugins: this.#plugins.plugins.map((manifest) => ({
            id: manifest.id,
            title: manifest.name,
            description: manifest.capabilities.join(', '),
          })),
          home: homedir(),
        },
      }),
    );
  }

  #bind(client: Client, session: Session): number {
    const streamId = client.nextStream++;
    client.streams.set(session.id, streamId);
    client.byStream.set(streamId, session.id);
    return streamId;
  }

  #unbind(client: Client, sessionId: string): void {
    const streamId = client.streams.get(sessionId);
    if (streamId !== undefined) client.byStream.delete(streamId);
    client.streams.delete(sessionId);
    client.flow.get(sessionId)?.dispose();
    client.flow.delete(sessionId);
  }

  #attach(client: Client, session: Session, streamId: number, cols: number, rows: number): void {
    const flow = new FlowController({
      windowBytes: this.#config.creditWindowBytes,
      coalesceMs: this.#config.coalesceMs,
      maxChunkBytes: this.#config.maxChunkBytes,
      send: (chunk) => send(client.socket, outputFrame(streamId, chunk)),
      onDesync: () => {
        warn('client.desync', { clientId: client.id, sessionId: session.id });
        this.#sendSnapshot(client, session, streamId);
        flow.resync();
      },
    });
    client.flow.get(session.id)?.dispose();
    client.flow.set(session.id, flow);

    // Snapshot first, then stream. The snapshot establishes the sequence point so the live
    // stream resumes with no gap and no duplication.
    this.#sendSnapshot(client, session, streamId);

    // Learn and remember where this session is, so a later expiry has something to offer.
    void this.#liveCwd(session).catch(() => {
      /* best effort: recovery detail is a nicety, not a requirement */
    });

    this.#sessions.attach(session, {
      clientId: client.id,
      cols,
      rows,
      onOutput: (data) => flow.push(data),
    });
  }

  #sendSnapshot(client: Client, session: Session, streamId: number): void {
    const snap = session.vt.snapshot(this.#config.scrollbackLines);
    send(
      client.socket,
      controlFrame({
        t: 'snapshot',
        snapshot: {
          sessionId: session.id,
          streamId,
          seq: snap.seq,
          cols: snap.cols,
          rows: snap.rows,
          screen: snap.screen,
          scrollback: '',
          altScreen: snap.altScreen,
        },
      }),
    );
  }
}

function send(socket: WebSocket, data: Uint8Array): void {
  if (socket.readyState === 1) socket.send(data, { binary: true });
}

function sendError(socket: WebSocket, code: ServerErrorCode, message: string): void {
  send(socket, controlFrame({ t: 'error', code, message }));
}

/** Expand ~ and resolve to an absolute path, or refuse. */
function expandPath(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 4096 || trimmed.includes('\0')) return null;
  let expanded = trimmed;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = resolvePath(homedir(), expanded.slice(2));
  const absolute = isAbsolute(expanded) ? expanded : resolvePath(homedir(), expanded);
  return absolute.startsWith('/') ? absolute : null;
}

function toBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

export { ackFrame };

/**
 * How long ago something was saved, in words.
 *
 * A restore notice saying "restored 1754377200000" would be useless. The point of the line is
 * that a person immediately understands what they are looking at.
 */
function describeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${String(minutes)} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)} hours ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}
