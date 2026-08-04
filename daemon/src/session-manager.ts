import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { SessionState, TitleFields } from '@tabterm/shared';
import type { Config } from './config.js';
import { debug, info, warn } from './log.js';
import { killPty, spawnPty, type PtyHandle } from './pty-manager.js';
import { assertTransition } from './session-state.js';
import { VtState } from './vt-state.js';

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
  titleFields: TitleFields;
  handle: PtyHandle;
  vt: VtState;
  clients: Map<string, AttachedClient>;
  reapTimer?: NodeJS.Timeout;
}

export interface SessionEvents {
  onExit: (session: Session) => void;
  onStateChange: (session: Session) => void;
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
      titleFields: { cwd },
      handle,
      vt,
      clients: new Map(),
    };
    if (opts.command) session.command = opts.command;

    // The daemon always drains. This listener is never removed while the session lives.
    handle.pty.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      vt.write(buf);
      for (const client of session.clients.values()) client.onOutput(buf);
    });

    handle.pty.onExit(({ exitCode, signal }) => {
      session.exitCode = exitCode;
      if (signal !== undefined) session.signal = signal;
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
    this.#scheduleReap(session);
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

  #scheduleReap(session: Session): void {
    if (session.pinned) return;
    const seconds = this.#reapDelay(session);
    session.reapTimer = setTimeout(() => {
      void this.kill(session);
    }, seconds * 1000);
    this.#transition(session, 'expiring');
    debug('session.reap.scheduled', { sessionId: session.id, seconds });
  }

  #reapDelay(session: Session): number {
    const cmd = session.command?.[0] ?? '';
    if (/(^|\/)(vim|nvim|emacs|ssh|claude|agent)$/.test(cmd)) {
      return this.#config.reapAgentOrEditorSeconds;
    }
    if (!session.command) return this.#config.reapIdleShellSeconds;
    return this.#config.reapDefaultSeconds;
  }

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
