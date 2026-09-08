import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { controlFrame, decodeFrames } from './framing.js';
import { info, warn } from '../log.js';
import { HOST_PROTOCOL } from './host.js';

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

/**
 * A spawn failure a person can act on.
 *
 * Node wraps the underlying failure in its own text, and the useful part is usually one clause
 * of it. Anything unrecognized is passed through rather than replaced, because a message nobody
 * predicted is still better than a generic one.
 */
export function readableSpawnError(raw: string): string {
  const text = raw.replace(/^Error:\s*/, '').trim();
  if (/command not found/i.test(text)) {
    return `TabTerm: ${text}. It is not on the PATH your login shell provides.`;
  }
  if (/ENOENT/i.test(text)) return `TabTerm: that program could not be found. ${text}`;
  if (/EACCES/i.test(text)) return `TabTerm: that program is not executable. ${text}`;
  if (/ENOTDIR|ENOENT.*chdir/i.test(text)) return `TabTerm: that directory does not exist. ${text}`;
  return text === '' ? 'TabTerm: the program could not be started.' : `TabTerm: ${text}`;
}

export class PtyHostClient {
  #socket: Socket | null = null;
  #pending = new Uint8Array(0);
  #dataListeners: DataListener[] = [];
  #exitListeners: ExitListener[] = [];
  #spawnListeners: ((sessionId: string, pid: number) => void)[] = [];
  #reconnecting = false;
  #onReconnect: (() => void) | undefined;
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
            /**
             * An older host is reported, never replaced.
             *
             * The whole point of this design is that a running host holds everybody's terminals
             * and outlives the daemon, so an update stages new code and the old process keeps
             * running until it stops for its own reasons. That means a new daemon can find a
             * host speaking an older protocol, and the one thing it must not do about that is
             * restart it: that would trade a compatibility question for certain data loss.
             *
             * Recorded so a mismatch is visible in the log rather than surfacing later as
             * inexplicable behavior. The protocol is deliberately small and additive for this
             * reason, so an older host missing a newer message is the realistic worst case.
             */
            const speaks = Number(hello['protocol']);
            if (Number.isFinite(speaks) && speaks !== HOST_PROTOCOL) {
              warn('pty-host.protocol-mismatch', {
                host: speaks,
                daemon: HOST_PROTOCOL,
                note: 'left running on purpose: restarting it would end every terminal it holds',
              });
            }
            info('pty-host.connected', { pid: hello['pid'], protocol: speaks });
            this.#identify(hello['instance']);
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
    /**
     * Nothing held is sent yet, because we do not know who is on the other end.
     *
     * The outbox can hold writes, resizes and kills aimed at sessions in the host we were talking
     * to. Flushing them the moment a socket exists sends them to whatever answered, which after a
     * host has been replaced is a different process with different sessions: at best the frames
     * are ignored, at worst a kill lands on an id the new host happens to know.
     *
     * `hello` decides. See `#identify`.
     */

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
          /**
           * Nothing is running, so the session has effectively already ended.
           *
           * The reason is written into the session's own output before the exit, which is how a
           * shell reports a command it could not find. It reaches the screen, the scrollback,
           * and any tab that reattaches later, and it says which command and why. A tab that
           * showed "exit 1" and nothing else left somebody with no way to tell a missing agent
           * CLI from a crash.
           */
          const sessionId = String(msg['sessionId']);
          const raw = msg['error'];
          const reason = readableSpawnError(typeof raw === 'string' ? raw : '');
          warn('pty-host.spawn-failed', { sessionId, error: msg['error'] });
          const notice = Buffer.from(`\r\n\u001b[31m${reason}\u001b[0m\r\n`, 'utf8');
          for (const fn of this.#dataListeners) fn(sessionId, notice, 0);
          for (const fn of this.#exitListeners) fn(sessionId, 1);
        }
        if (t === 'message-failed') {
          // The host could not act on something we asked for. Recorded, because a request that
          // silently did nothing is the hardest kind of failure to find later.
          warn('pty-host.message-failed', { error: msg['message'], about: msg['about'] });
        }
        if (t === 'killed') this.#onKilled(msg);
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
      /**
       * Get it back.
       *
       * Without this, a host that died took the whole product with it: the daemon kept running,
       * every send went to a closed socket, and no new terminal could be created until the
       * daemon itself was restarted. The sessions the host was holding are genuinely gone, which
       * cannot be helped, but everything after that must keep working.
       */
      this.#scheduleReconnect();
    });
    socket.on('error', () => socket.destroy());
  }

  /**
   * Reconnect, restarting the host if nothing is serving.
   *
   * Backed off so a host that cannot start does not become a spawn loop, and capped rather than
   * unbounded because a person waiting on a terminal will not wait minutes for one.
   */
  #scheduleReconnect(): void {
    if (this.#reconnecting) return;
    this.#reconnecting = true;
    const attempt = (delay: number): void => {
      setTimeout(() => {
        void this.connect(4000).then((ok) => {
          if (ok) {
            this.#reconnecting = false;
            info('pty-host.reconnected', {});
            this.#onReconnect?.();
            return;
          }
          attempt(Math.min(delay * 2, 10_000));
        });
      }, delay);
    };
    attempt(300);
  }

  /** Told when a new host is serving, since every session the old one held is gone. */
  onReconnect(fn: () => void): void {
    this.#onReconnect = fn;
  }

  /**
   * Held while there is no socket, and sent when there is one again.
   *
   * Messages used to be dropped silently whenever the connection was down, which is a window
   * that genuinely happens: the host is restarting, or has just been killed and the daemon has
   * not reconnected yet. A `spawn` lost in that window leaves a tab with a pane that never
   * receives anything, forever, with no error anywhere. That is a lost terminal, which is the
   * one outcome this product cannot have.
   *
   * Bounded, because a host that never comes back must not turn into unbounded memory. The
   * oldest go first: a stale `write` for a session that no longer exists is worth less than the
   * `spawn` that would create a new one.
   */
  #outbox: unknown[] = [];

  #send(message: unknown): void {
    if (this.#socket && !this.#socket.destroyed) {
      this.#socket.write(controlFrame(message));
      return;
    }
    this.#outbox.push(message);
    if (this.#outbox.length > 500) this.#outbox.shift();
  }

  /**
   * Which host process we are talking to, once it has said.
   *
   * `null` until the first `hello` of this daemon's life. Compared on every reconnect, because
   * the whole question a reconnect raises is whether the terminals we were holding are still
   * there, and only the host can answer that.
   */
  #instance: string | null = null;

  /** True when the last connection reached a different host process than the one before it. */
  #instanceChanged = false;

  get hostInstance(): string | null {
    return this.#instance;
  }

  /** Whether the host we are now connected to is a different process than the one before. */
  get hostReplaced(): boolean {
    return this.#instanceChanged;
  }

  /**
   * Take the identity from a `hello-ok`, and decide what the outbox is still worth.
   *
   * Same host: everything held is still addressed to sessions that still exist, so it goes.
   * Different host, or a host too old to say: nothing session-targeted goes at all. Those frames
   * name sessions this process has never heard of, and one of them can be a kill.
   */
  /** A host saying it acted on a kill. See `killAndWait`. */
  #onKilled(msg: Record<string, unknown>): void {
    const requestId = typeof msg['requestId'] === 'string' ? msg['requestId'] : '';
    this.#killWaits.get(requestId)?.();
  }

  #identify(raw: unknown): void {
    const instance = typeof raw === 'string' && raw !== '' ? raw : null;
    const previous = this.#instance;
    this.#instanceChanged = previous !== null && instance !== previous;
    this.#instance = instance;

    if (instance === null) {
      warn('pty-host.no-instance', {
        note: 'host too old to identify itself; nothing held will be sent to it',
      });
      this.#dropOutbox('unidentified-host');
      return;
    }
    if (this.#instanceChanged) {
      warn('pty-host.replaced', { was: previous, now: instance });
      this.#dropOutbox('host-replaced');
      return;
    }
    if (previous === null) info('pty-host.instance', { instance });
    this.#flush();
  }

  /**
   * Throw away what was held, saying how much and why.
   *
   * Dropping is the safe direction here and it is not free: a write somebody typed is lost. It is
   * lost either way once the process it was aimed at is gone, and sending it to a stranger is the
   * version that can do damage.
   */
  #dropOutbox(reason: string): void {
    if (this.#outbox.length === 0) return;
    warn('pty-host.outbox-dropped', { messages: this.#outbox.length, reason });
    this.#outbox = [];
  }

  /** Everything that was held, in the order it was asked for. */
  #flush(): void {
    if (this.#outbox.length === 0) return;
    const waiting = this.#outbox;
    this.#outbox = [];
    info('pty-host.flushed', { messages: waiting.length });
    for (const message of waiting) this.#send(message);
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

  /**
   * Put something on a session's screen without sending it to the shell.
   *
   * The distinction matters: `write` is input and reaches whatever program is in the foreground.
   * This is output, and reaches only the screen and the scrollback.
   */
  inject(sessionId: string, data: string): void {
    this.#send({ t: 'inject', sessionId, data });
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

  /**
   * Ask the host to end a session, and wait to be told it did.
   *
   * Resolves true when the host answered, whether or not it still had the session: either way
   * the process is not running there any more, and the daemon can let go of its record. Resolves
   * false when nothing answered, which means the daemon does **not** know what happened and must
   * keep the record rather than quietly forgetting a process that may still be running with
   * nothing able to see or reach it.
   */
  async killAndWait(sessionId: string, keepHistory = false, timeoutMs = 4000): Promise<boolean> {
    const requestId = randomUUID();
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#killWaits.delete(requestId);
        resolve(false);
      }, timeoutMs);
      this.#killWaits.set(requestId, () => {
        clearTimeout(timer);
        this.#killWaits.delete(requestId);
        resolve(true);
      });
    });
    /**
     * Not queued when there is nowhere to send it.
     *
     * A kill held in the outbox is aimed at a host that may be gone by the time anything is
     * flushed, and the caller is about to be told nothing happened, which is the truth.
     */
    if (!this.#socket || this.#socket.destroyed) {
      this.#killWaits.delete(requestId);
      return false;
    }
    this.#socket.write(controlFrame({ t: 'kill', sessionId, keepHistory, requestId }));
    return answered;
  }

  readonly #killWaits = new Map<string, () => void>();

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
