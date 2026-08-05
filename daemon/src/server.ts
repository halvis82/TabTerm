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
import type { WorkspaceStore } from './workspace-store.js';
import type { Session, SessionManager } from './session-manager.js';

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

export class DaemonServer {
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #config: Config;
  readonly #sessions: SessionManager;
  readonly #workspaces: WorkspaceStore;
  readonly #launcher: LauncherData;
  readonly #clients = new Set<Client>();

  constructor(
    config: Config,
    sessions: SessionManager,
    workspaces: WorkspaceStore,
    launcher: LauncherData,
  ) {
    this.#config = config;
    this.#sessions = sessions;
    this.#workspaces = workspaces;
    this.#launcher = launcher;
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

  broadcast(message: ServerMessage): void {
    for (const c of this.#clients) {
      if (c.authed && c.role === 'control') send(c.socket, controlFrame(message));
    }
  }

  notifySession(session: Session, message: ServerMessage): void {
    for (const c of this.#clients) {
      if (c.authed && c.streams.has(session.id)) send(c.socket, controlFrame(message));
    }
  }

  async close(): Promise<void> {
    for (const c of this.#clients) c.socket.close(1001, 'daemon shutting down');
    await new Promise<void>((r) => this.#wss.close(() => r()));
    await new Promise<void>((r) => this.#http.close(() => r()));
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
            await openPath(resolved.absolute, msg.how);
          })
          .catch(() => {
            sendError(client.socket, 'path-not-found', 'could not open path');
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
        send(
          client.socket,
          controlFrame({
            t: 'history-page',
            entries: this.#launcher.history(msg.query ?? '', msg.limit ?? 200),
          }),
        );
        return;
      }

      case 'save-item': {
        this.#launcher.save({
          title: msg.title,
          body: msg.body,
          ...(msg.tags ? { tags: msg.tags } : {}),
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
        send(client.socket, controlFrame({ t: 'history-page', entries: [] }));
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
          // No plugins exist yet, so the launcher renders no plugin section at all.
          plugins: [],
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
