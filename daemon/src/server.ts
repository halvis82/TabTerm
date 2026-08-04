import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AUTH_TIMEOUT_MS,
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
  readonly #clients = new Set<Client>();

  constructor(config: Config, sessions: SessionManager) {
    this.#config = config;
    this.#sessions = sessions;
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
        if (s) this.#sessions.detach(s, client.id);
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
        const streamId = this.#bind(client, session);
        send(
          client.socket,
          controlFrame({
            t: 'session-created',
            sessionId: session.id,
            streamId,
            pid: session.pid,
          }),
        );
        this.#attach(client, session, streamId, msg.cols, msg.rows);
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
    if (fromOs) {
      session.cwd = fromOs;
      return fromOs;
    }
    return session.cwd;
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

function toBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

export { ackFrame };
