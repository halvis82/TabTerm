import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { controlFrame, decodeFrames } from './framing.js';
import { info, warn } from '../log.js';

/**
 * The daemon's end of the PTY host.
 *
 * Presents the same shape the daemon used when it owned PTYs directly, so the session manager
 * reads almost unchanged: spawn, write, resize, kill, plus data and exit callbacks. What is new
 * is `adopt`, which is the whole point. A daemon that starts and finds sessions already running
 * takes them over instead of starting again.
 *
 * See docs/adr/0017 and docs/01-architecture.md.
 */

export interface HostSessionInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  seq: number;
  alive: boolean;
  stash?: { seq: number; state: string };
}

export interface SpawnRequest {
  sessionId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  command?: readonly string[];
  env?: Record<string, string>;
}

type DataListener = (sessionId: string, data: Buffer, seq: number) => void;
type ExitListener = (sessionId: string, exitCode: number, signal?: number) => void;

export class PtyHostClient {
  #socket: Socket | null = null;
  #pending = new Uint8Array(0);
  #dataListeners: DataListener[] = [];
  #exitListeners: ExitListener[] = [];
  #spawnListeners: ((sessionId: string, pid: number) => void)[] = [];
  readonly #waiting = new Map<string, (msg: Record<string, unknown>) => void>();
  readonly #socketPath: string;
  readonly #hostScript: string;
  readonly #nodePath: string;

  constructor(opts: { socketPath: string; hostScript: string; nodePath?: string }) {
    this.#socketPath = opts.socketPath;
    this.#hostScript = opts.hostScript;
    this.#nodePath = opts.nodePath ?? process.execPath;
  }

  onData(fn: DataListener): void {
    this.#dataListeners.push(fn);
  }

  onExit(fn: ExitListener): void {
    this.#exitListeners.push(fn);
  }

  /**
   * Connect, starting the host if nothing is serving.
   *
   * Retried rather than attempted once, because the common case is a race: the daemon starts,
   * finds no socket, spawns a host, and has to wait for it to bind.
   */
  async connect(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let spawned = false;

    while (Date.now() < deadline) {
      if (existsSync(this.#socketPath)) {
        const socket = await this.#tryConnect();
        if (socket) {
          this.#attach(socket);
          const hello = await this.#request({ t: 'hello' }, 'hello-ok');
          if (hello) {
            info('pty-host.connected', { pid: hello['pid'] });
            return true;
          }
        }
      }
      if (!spawned) {
        this.#startHost();
        spawned = true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    warn('pty-host.unreachable', { socket: this.#socketPath });
    return false;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  #tryConnect(): Promise<Socket | null> {
    return new Promise((resolve) => {
      const socket = connect(this.#socketPath);
      const fail = (): void => {
        socket.destroy();
        resolve(null);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.removeListener('error', fail);
        resolve(socket);
      });
    });
  }

  /**
   * Start the host as a detached process.
   *
   * Detached is load bearing. A child in the daemon's process group dies with it, and
   * `launchctl kickstart -k` kills the group, which would make this whole design pointless.
   * stdio is ignored rather than inherited for the same reason: an inherited pipe keeps a
   * handle to a parent that is supposed to be replaceable.
   */
  #startHost(): void {
    try {
      const child = spawn(this.#nodePath, [this.#hostScript], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      info('pty-host.starting', { script: this.#hostScript });
    } catch (e: unknown) {
      warn('pty-host.start-failed', { error: String(e) });
    }
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    this.#pending = new Uint8Array(0);

    socket.on('data', (chunk: Buffer) => {
      const merged = new Uint8Array(this.#pending.length + chunk.length);
      merged.set(this.#pending);
      merged.set(chunk, this.#pending.length);
      let decoded;
      try {
        decoded = decodeFrames(merged);
      } catch {
        socket.destroy();
        return;
      }
      this.#pending = merged.subarray(decoded.consumed);

      for (const frame of decoded.frames) {
        if (frame.kind === 'output') {
          const buf = Buffer.from(frame.frame.data);
          for (const fn of this.#dataListeners) fn(frame.frame.sessionId, buf, frame.frame.seq);
          continue;
        }
        const msg = frame.message as Record<string, unknown>;
        const t = String(msg['t']);
        if (t === 'spawned') {
          const pid = Number(msg['pid']);
          if (Number.isFinite(pid) && pid > 0) {
            for (const fn of this.#spawnListeners) fn(String(msg['sessionId']), pid);
          }
        }
        if (t === 'spawn-failed') {
          // Nothing is running, so the session has effectively already ended. Reported as an
          // exit rather than silently: a pane that will never produce output must say so.
          warn('pty-host.spawn-failed', { sessionId: msg['sessionId'], error: msg['error'] });
          for (const fn of this.#exitListeners) fn(String(msg['sessionId']), 1);
        }
        if (t === 'exited') {
          for (const fn of this.#exitListeners) {
            fn(String(msg['sessionId']), Number(msg['exitCode']), msg['signal'] as number);
          }
        }
        const waiter = this.#waiting.get(t);
        if (waiter) {
          this.#waiting.delete(t);
          waiter(msg);
        }
      }
    });

    socket.on('close', () => {
      this.#socket = null;
      warn('pty-host.disconnected', {});
    });
    socket.on('error', () => socket.destroy());
  }

  #send(message: unknown): void {
    if (this.#socket && !this.#socket.destroyed) this.#socket.write(controlFrame(message));
  }

  async #request(
    message: unknown,
    expect: string,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(expect);
        resolve(null);
      }, timeoutMs);
      this.#waiting.set(expect, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.#send(message);
    });
  }

  /** What is already running. The answer a restarted daemon needs before it does anything. */
  async list(): Promise<HostSessionInfo[]> {
    const reply = await this.#request({ t: 'list' }, 'sessions');
    return (reply?.['sessions'] as HostSessionInfo[] | undefined) ?? [];
  }

  /**
   * Ask for a PTY, without waiting.
   *
   * The socket preserves order, and the host spawns synchronously when it reads the frame, so a
   * write sent immediately after this one still finds its session.
   */
  spawn(req: SpawnRequest): void {
    this.#send({
      t: 'spawn',
      sessionId: req.sessionId,
      options: {
        sessionId: req.sessionId,
        shell: req.shell,
        cwd: req.cwd,
        cols: req.cols,
        rows: req.rows,
        ...(req.command ? { command: req.command } : {}),
        ...(req.env ? { env: req.env } : {}),
      },
    });
  }

  onSpawned(fn: (sessionId: string, pid: number) => void): void {
    this.#spawnListeners.push(fn);
  }

  write(sessionId: string, data: string): void {
    this.#send({ t: 'write', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#send({ t: 'resize', sessionId, cols, rows });
  }

  /** Everything kept on disk for a session, including one whose process has ended. */
  async history(sessionId: string): Promise<void> {
    await this.#request({ t: 'history', sessionId }, 'history-end');
  }

  /** Drop a session's buffered output. Part of clear actually clearing. */
  clear(sessionId: string): void {
    this.#send({ t: 'clear', sessionId });
  }

  /** How much output to keep per session, in bytes. */
  setBudget(bytes: number): void {
    this.#send({ t: 'budget', bytes });
  }

  kill(sessionId: string): void {
    this.#send({ t: 'kill', sessionId });
  }

  /** Hand over screen state, so the next daemon can restore it exactly rather than approximately. */
  stash(sessionId: string, seq: number, state: string): void {
    this.#send({ t: 'stash', sessionId, seq, state });
  }

  /** Ask for everything after a sequence number. Output arrives through the data listeners. */
  async replay(sessionId: string, fromSeq: number): Promise<void> {
    await this.#request({ t: 'replay', sessionId, fromSeq }, 'replayed');
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}
