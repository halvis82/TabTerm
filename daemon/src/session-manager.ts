import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { AgentState, SessionState, TitleFields } from '@tabterm/shared';
import type { Config } from './config.js';
import { debug, info, warn } from './log.js';
import { killPty, spawnPty, type PtyHandle } from './pty-manager.js';
import { OscScanner } from './osc.js';
import { decideReap, describeReap, reapInputFor } from './cleanup.js';
import { listeningPorts } from './server-detect.js';
import { assertTransition } from './session-state.js';
import { VtState } from './vt-state.js';

/**
 * How long after a command starts to look for a listening socket.
 *
 * Long enough for a dev server to bind, short enough that the offer arrives while the user is
 * still watching the output that started it.
 */
const SERVER_CHECK_MS = 2500;

export interface AttachedClient {
  clientId: string;
  cols: number;
  rows: number;
  /** Called with raw PTY bytes. The transport decides how to frame them. */
  onOutput: (data: Buffer) => void;
}

export interface Session {
  id: string;
  state: SessionState;
  createdAt: number;
  lastAttachedAt: number;
  lastDetachedAt?: number;
  cwd: string;
  shell: string;
  command?: readonly string[];
  pid: number;
  exitCode?: number;
  signal?: number;
  pinned: boolean;
  persistent: boolean;
  /** Set when a listening socket is attributed to this session. Protects it from reaping. */
  listeningPort?: number;
  /** Best-known foreground program, consulted by the reap policy. */
  foregroundProcess?: string;
  /** Latest state reported by an agent CLI's hooks, never inferred from output. */
  agentState?: AgentState;
  titleFields: TitleFields;
  handle: PtyHandle;
  vt: VtState;
  clients: Map<string, AttachedClient>;
  reapTimer?: NodeJS.Timeout;
  serverCheckTimer?: NodeJS.Timeout;
  /** Set while a command is running, so the title can show it rather than the shell. */
  commandRunning: boolean;
  commandStartedAt?: number;
  pendingCommand?: string;
  lastExitCode?: number;
}

export interface SessionEvents {
  onExit: (session: Session) => void;
  onStateChange: (session: Session) => void;
  /** Fired when the shell reports a new directory via OSC 7. */
  onCwd?: (session: Session) => void;
  /** Fired when the composed title fields change. */
  onTitle?: (session: Session) => void;
  /** Fired when a shell command starts, so a pane can show it ticking. */
  onCommandStarted?: (session: Session, command: string, startedAt: number) => void;
  /** Fired when a shell command finishes, with what it was and how it went. */
  onCommand?: (session: Session, command: string, exitCode: number, durationMs: number) => void;
  /** A session started listening on a local port. Fired once per port, never polled. */
  onServerDetected?: (session: Session, port: number) => void;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #config: Config;
  readonly #events: SessionEvents;

  constructor(config: Config, events: SessionEvents) {
    this.#config = config;
    this.#events = events;
  }

  get all(): Session[] {
    return [...this.#sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  create(opts: { cwd?: string; command?: readonly string[]; cols: number; rows: number }): Session {
    const id = randomUUID();
    const cwd = opts.cwd ?? homedir();
    const handle = spawnPty({
      shell: this.#config.shell,
      cwd,
      cols: opts.cols,
      rows: opts.rows,
      sessionId: id,
      ...(opts.command ? { command: opts.command } : {}),
    });

    const vt = new VtState(opts.cols, opts.rows, this.#config.scrollbackLines);

    const session: Session = {
      id,
      state: 'starting',
      createdAt: Date.now(),
      lastAttachedAt: Date.now(),
      cwd,
      shell: this.#config.shell,
      pid: handle.pid,
      pinned: false,
      persistent: false,
      titleFields: { cwd },
      handle,
      vt,
      clients: new Map(),
      commandRunning: false,
    };
    if (opts.command) session.command = opts.command;

    // Shell integration reports meaning the daemon cannot infer from bytes alone.
    const osc = new OscScanner({
      onCwd: (cwd) => {
        if (cwd === session.cwd) return;
        session.cwd = cwd;
        session.titleFields = { ...session.titleFields, cwd };
        this.#events.onCwd?.(session);
        this.#events.onTitle?.(session);
      },
      onCommandStart: () => {
        session.commandRunning = true;
        session.commandStartedAt = Date.now();
      },
      onCommandText: (command) => {
        session.pendingCommand = command;
        // The text arrives just after the start mark, so the start event waits for it: a
        // pane showing "running" without saying what is more alarming than useful.
        const startedAt = session.commandStartedAt ?? Date.now();
        this.#events.onCommandStarted?.(session, command, startedAt);
        this.#checkForServer(session);
      },
      onCommandEnd: (exitCode) => {
        const startedAt = session.commandStartedAt;
        session.commandRunning = false;
        session.lastExitCode = exitCode;
        delete session.commandStartedAt;
        this.#events.onTitle?.(session);
        // The command text comes from the shell integration. Without it sourced there is
        // simply nothing to record, and history stays empty rather than guessing.
        const text = session.pendingCommand;
        delete session.pendingCommand;
        if (text) {
          this.#events.onCommand?.(session, text, exitCode, startedAt ? Date.now() - startedAt : 0);
        }
      },
      onPromptStart: () => {
        session.commandRunning = false;
      },
    });

    // The daemon always drains. This listener is never removed while the session lives.
    handle.pty.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      vt.write(buf);
      osc.feed(chunk);
      for (const client of session.clients.values()) client.onOutput(buf);
    });

    handle.pty.onExit(({ exitCode, signal }) => {
      session.exitCode = exitCode;
      if (signal !== undefined) session.signal = signal;

      // A pane that ran a declared command keeps its output, so the notice goes into the
      // terminal state itself rather than being drawn by whoever happens to be attached.
      // Reattaching later shows the same thing. See docs/04-session-lifecycle.md §9.
      if (session.command?.length) {
        const notice = `\r\n\x1b[2m[${describeExit(exitCode, signal)}]\x1b[0m\r\n`;
        const buf = Buffer.from(notice, 'utf8');
        vt.write(buf);
        for (const client of session.clients.values()) client.onOutput(buf);
      }

      this.#transition(session, 'exited');
      info('session.exited', { sessionId: id, exitCode, signal });
      this.#events.onExit(session);
    });

    this.#sessions.set(id, session);
    info('session.created', { sessionId: id, pid: handle.pid });
    return session;
  }

  attach(session: Session, client: AttachedClient): void {
    if (session.state === 'exited' || session.state === 'reaped') {
      throw new Error('session-expired');
    }
    session.clients.set(client.clientId, client);
    session.lastAttachedAt = Date.now();
    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
      debug('session.reap.cancelled', { sessionId: session.id });
    }
    this.#transition(session, 'attached');
    this.#applyResize(session);
  }

  detach(session: Session, clientId: string): void {
    if (!session.clients.delete(clientId)) return;
    if (session.clients.size > 0) {
      this.#applyResize(session);
      return;
    }
    session.lastDetachedAt = Date.now();
    if (session.state === 'exited' || session.state === 'reaped') return;
    this.#transition(session, 'detached');

    // Check for a listening socket before deciding. This is the only moment the answer
    // matters, so it is asked here rather than polled.
    void listeningPorts([session.pid])
      .then((ports) => {
        const port = ports.get(session.pid);
        if (port !== undefined) session.listeningPort = port;
      })
      .catch(() => {
        /* detection is best effort; without it the session just follows the normal policy */
      })
      .finally(() => {
        if (session.state === 'detached') this.#scheduleReap(session);
      });
  }

  resize(session: Session, clientId: string, cols: number, rows: number): void {
    const client = session.clients.get(clientId);
    if (!client) return;
    client.cols = cols;
    client.rows = rows;
    this.#applyResize(session);
  }

  write(session: Session, data: Buffer): void {
    if (session.state === 'exited' || session.state === 'reaped') return;
    session.handle.pty.write(data.toString('utf8'));
  }

  setPersistent(session: Session, persistent: boolean): void {
    session.persistent = persistent;
    if (persistent && session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
    }
  }

  setPinned(session: Session, pinned: boolean): void {
    session.pinned = pinned;
    if (pinned && session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
    }
  }

  async kill(session: Session): Promise<void> {
    await killPty(session.handle, session.id);
    this.#reap(session);
  }

  /**
   * The PTY has one size. With N attached clients the applied size is the minimum cols and
   * minimum rows across all of them, computed per dimension. Any larger client would render
   * into columns the shell does not know exist. See docs/04-session-lifecycle.md §2.
   */
  #applyResize(session: Session): void {
    if (session.clients.size === 0) return; // Retain the last size when nobody is attached.
    let cols = Infinity;
    let rows = Infinity;
    for (const c of session.clients.values()) {
      cols = Math.min(cols, c.cols);
      rows = Math.min(rows, c.rows);
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols === session.vt.cols && rows === session.vt.rows) return;
    session.vt.resize(cols, rows);
    try {
      session.handle.pty.resize(cols, rows);
    } catch (e) {
      warn('session.resize.failed', { sessionId: session.id, error: String(e) });
    }
  }

  /**
   * Schedule a reap, or decline to.
   *
   * The decision and its reason are always logged. A session disappearing without an
   * explanation is indistinguishable from a bug. See docs/04-session-lifecycle.md §4.
   */
  /**
   * Look for a newly listening port shortly after a command starts.
   *
   * Event driven, not polled: a dev server binds within a second or two of being started, and
   * checking on that one event costs a single `lsof` rather than a timer that runs forever.
   * Reported once per port, so restarting a server on the same port does not re-announce it.
   */
  #checkForServer(session: Session): void {
    if (session.serverCheckTimer) clearTimeout(session.serverCheckTimer);
    const timer = setTimeout(() => {
      delete session.serverCheckTimer;
      void listeningPorts([session.pid])
        .then((ports) => {
          const port = ports.get(session.pid);
          if (port === undefined || port === session.listeningPort) return;
          session.listeningPort = port;
          this.#events.onServerDetected?.(session, port);
        })
        .catch(() => {
          /* best effort. A missing answer means no offer, which is the safe direction. */
        });
    }, SERVER_CHECK_MS);
    timer.unref();
    session.serverCheckTimer = timer;
  }

  #scheduleReap(session: Session): void {
    const decision = decideReap(
      reapInputFor(session, {
        inWorkspace: this.#inWorkspace(session.id),
        listeningPort: session.listeningPort,
      }),
      this.#config,
    );

    if (decision.afterSeconds === null) {
      info('session.reap.declined', { sessionId: session.id, reason: decision.reason });
      return;
    }

    session.reapTimer = setTimeout(() => {
      info('session.reaping', { sessionId: session.id, reason: decision.reason });
      void this.kill(session);
    }, decision.afterSeconds * 1000);
    this.#transition(session, 'expiring');
    debug('session.reap.scheduled', { sessionId: session.id, policy: describeReap(decision) });
  }

  /** Whether a session is a pane in a workspace. Injected, so the manager owns no layout state. */
  #inWorkspace(sessionId: string): boolean {
    return this.isInWorkspace?.(sessionId) ?? false;
  }

  /** Set by the daemon once the workspace store exists. */
  isInWorkspace?: (sessionId: string) => boolean;

  #transition(session: Session, to: SessionState): void {
    if (session.state === to) return;
    assertTransition(session.state, to);
    session.state = to;
    this.#events.onStateChange(session);
  }

  #reap(session: Session): void {
    if (session.reapTimer) clearTimeout(session.reapTimer);
    if (session.state !== 'reaped') {
      if (session.state !== 'exited') {
        try {
          this.#transition(session, 'exited');
        } catch {
          /* already terminal */
        }
      }
      try {
        this.#transition(session, 'reaped');
      } catch {
        /* already reaped */
      }
    }
    session.vt.dispose();
    session.clients.clear();
    this.#sessions.delete(session.id);
    info('session.reaped', { sessionId: session.id });
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.all.map((s) => killPty(s.handle, s.id)));
  }
}

/** Plain words for how a process ended, because an exit code alone tells most people nothing. */
function describeExit(exitCode: number, signal?: number): string {
  if (signal !== undefined && signal !== 0) return `killed by signal ${String(signal)}`;
  return exitCode === 0 ? 'finished' : `exited with code ${String(exitCode)}`;
}
