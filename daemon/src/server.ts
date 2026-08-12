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
import { listeningPorts } from './server-detect.js';
import { applyMemoryMode, frontendSettings } from './memory-modes.js';
import type { RestoreStore } from './restore-store.js';
import type { OutputArchive } from './output-archive.js';
import type { PluginHost } from './plugin-api.js';
import type { ProjectIndex } from './project-index.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { Session, SessionManager } from './session-manager.js';
import { agentHooksStatus, setAgentHooks } from './agent-hooks.js';
import { setShellIntegration, shellIntegrationStatus } from './shell-integration.js';
import { clampPolicy, decide, type Finished, type NotifyPolicy } from './notify-policy.js';
import { readUserSettings, updateUserSetting } from './user-settings.js';

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
          sendError(client.socket, 'internal', 'could not split');
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
          sendError(client.socket, 'internal', 'could not launch the agent');
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
          sendError(client.socket, 'path-not-found', 'could not create that layout');
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
          sendError(client.socket, 'internal', 'could not open that project workspace');
        });
        return;
      }

      case 'list-resumable': {
        void listResumable({
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          // Known directories make the store's lossy directory naming exact rather than a
          // guess. See daemon/src/agent-sessions.ts.
          knownDirs: this.#launcher.recentDirs(40).map((d) => d.path),
          limit: msg.limit ?? 8,
        })
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
        // Resuming is a spawn like any other. The id came from the store, but it is passed as
        // argv to the agent CLI and never through a shell.
        const session = this.#sessions.create({
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          command: [...this.#config.agentCommand, '--resume', msg.sessionId],
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
        const workspaces = this.#restore.list(live).map((entry) => ({
          workspaceId: entry.workspaceId,
          paneCount: entry.panes.length,
          savedAt: entry.savedAt,
          panes: entry.panes.map((pane) => ({
            cwd: pane.cwd,
            hadCommand: (pane.command?.length ?? 0) > 0,
            ...(pane.lastCommand ? { lastCommand: pane.lastCommand } : {}),
          })),
        }));
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
    this.snapshotWorkspace(workspaceId);
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

    let anchor = this.#workspaces.paneFor(workspace, first.id) as string;
    for (let i = 1; i < count; i++) {
      const session = this.#sessions.create({ cwd: target, cols: msg.cols, rows: msg.rows });
      const result = this.#workspaces.split(workspace.id, anchor, msg.direction, session.id);
      // Chain from the newest pane, so three panes come out evenly rather than nested one deep.
      anchor = result.paneId;
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
