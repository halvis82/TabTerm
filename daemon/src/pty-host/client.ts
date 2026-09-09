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
  /** Somebody typed into it. Kept by the host, so it lasts as long as the session does. */
  hasInput?: boolean;
  /** A person closed its pane. Kept by the host for the same reason. */
  paneClosedByUser?: boolean;
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

/**
 * Make room in a queue for an absent host without losing anything a person did.
 *
 * Pure and exported because it is the part with the judgement in it: what a bound may throw away
 * decides whether a terminal can silently swallow typing. It used to throw away the oldest, which
 * is close to the worst possible answer, since the oldest message for a session is its `spawn`.
 *
 * Three passes, in order of how little each costs.
 *
 * 1. **Coalesce.** A resize, a stash and a budget are each a statement of a current value, so only
 *    the last per session says anything true. A resize storm is what fills this queue in practice
 *    and it compresses to nothing.
 * 2. **Drop housekeeping** addressed to a session with no input and no spawn at stake.
 * 3. **Give up one session's input, and name it.** Only if the queue is still over the bound. Its
 *    `spawn` goes with it: a session created and handed a hole in its input is a terminal in a
 *    state nobody asked for, and a write addressed to a session that was never created is not a
 *    smaller loss than a dropped write.
 */
export function trimOutbox(
  messages: readonly unknown[],
  limit: number,
): { kept: unknown[]; lostInputFor: string[] } {
  const idOf = (m: unknown): string => {
    const o = m as { sessionId?: unknown };
    return typeof o.sessionId === 'string' ? o.sessionId : '';
  };
  const typeOf = (m: unknown): string => {
    const o = m as { t?: unknown };
    return typeof o.t === 'string' ? o.t : '';
  };

  let kept = [...messages];
  if (kept.length <= limit) return { kept, lostInputFor: [] };

  const lastAt = new Map<string, number>();
  kept.forEach((m, i) => {
    const t = typeOf(m);
    if (t === 'resize' || t === 'stash' || t === 'budget') lastAt.set(`${t}:${idOf(m)}`, i);
  });
  kept = kept.filter((m, i) => {
    const t = typeOf(m);
    if (t !== 'resize' && t !== 'stash' && t !== 'budget') return true;
    return lastAt.get(`${t}:${idOf(m)}`) === i;
  });
  if (kept.length <= limit) return { kept, lostInputFor: [] };

  const atStake = new Set<string>();
  for (const m of kept) {
    const t = typeOf(m);
    if (t === 'write' || t === 'inject' || t === 'spawn') atStake.add(idOf(m));
  }
  kept = kept.filter((m) => {
    const t = typeOf(m);
    if (t !== 'mark' && t !== 'clear') return true;
    return atStake.has(idOf(m));
  });
  if (kept.length <= limit) return { kept, lostInputFor: [] };

  const lostInputFor: string[] = [];
  while (kept.length > limit) {
    const held = new Map<string, number>();
    for (const m of kept) {
      const t = typeOf(m);
      if (t === 'write' || t === 'inject') held.set(idOf(m), (held.get(idOf(m)) ?? 0) + 1);
    }
    let worst = '';
    let most = 0;
    for (const [id, n] of held) {
      if (n > most) {
        most = n;
        worst = id;
      }
    }
    if (worst === '') {
      // Nothing left that is input, so the bound cannot be met without losing something that is
      // not. Keep the newest, which is the closest thing to the current state of the world.
      kept = kept.slice(-limit);
      break;
    }
    lostInputFor.push(worst);
    kept = kept.filter((m) => idOf(m) !== worst);
  }
  return { kept, lostInputFor };
}

/** How much may be held for a host that is not there. See `trimOutbox` for what gives way. */
const OUTBOX_LIMIT = 500;

export class PtyHostClient {
  #socket: Socket | null = null;
  #pending = new Uint8Array(0);
  #dataListeners: DataListener[] = [];
  #exitListeners: ExitListener[] = [];
  #spawnListeners: ((sessionId: string, pid: number) => void)[] = [];
  #reconnecting = false;
  #onReconnect: (() => void) | undefined;
  /**
   * Requests in flight, keyed by the id that will come back with the answer.
   *
   * Keyed by the **reply type** before, which is only correct while at most one request of each
   * type is outstanding. Two `replay` calls at once, which a daemon adopting several sessions
   * makes naturally, had the second overwrite the first: the first never resolved and timed out,
   * and the second took whichever answer arrived first, possibly for the other session entirely.
   *
   * `kill` already carried a `requestId` because getting that one wrong ends the wrong terminal.
   * The same discipline now covers the rest, where getting it wrong hands back the wrong screen.
   */
  readonly #waiting = new Map<
    string,
    { expect: string; resolve: (msg: Record<string, unknown>) => void }
  >();

  /** Distinct per request, per client. Only ever compared, never parsed. */
  #nextRequestId = 0;
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

  /**
   * How far each session's output has actually been handed on.
   *
   * The host's sequence is the only authority on order, and this is the daemon's position in it.
   * A frame is handed on only when its sequence is beyond this, and doing so advances it, so
   * nothing is ever delivered twice or out of order.
   */
  readonly #deliveredThrough = new Map<string, number>();

  /**
   * Live output held back until the daemon has caught up.
   *
   * The host adds a socket to its broadcast set the moment it connects, before any handshake, so a
   * reconnecting daemon starts receiving live output immediately and asks for the range it missed
   * afterwards. Those are two streams down one socket with nothing sequencing them, and the
   * observed order was `171, 241, 109, 170, 171, 241`: bytes from after the break first, then
   * older bytes, then the same two again.
   *
   * Applied in that order to a terminal emulator that is not a glitch. It is a wrong screen that
   * nothing downstream can detect, which for a product whose promise is the exact screen is the
   * worst kind of wrong.
   *
   * So a fresh connection reconciles before it goes live: live frames are held with their
   * sequence, the replay the daemon asks for lands in the same buffer, and `reconciled()` merges
   * both by sequence and delivers each byte once.
   */
  #reconciling = false;
  #held: { sessionId: string; data: Buffer; seq: number }[] = [];
  #heldBytes = 0;

  /**
   * What the hold may grow to before it stops being a kindness.
   *
   * Reached only if catching up never finishes, and the alternative to a bound is the daemon
   * growing without one while a session pours out output. On overflow the hold is released in
   * order: a screen may then be missing bytes, which is visible and recoverable, rather than the
   * daemon dying, which is not.
   */
  static readonly HOLD_LIMIT_BYTES = 8 * 1024 * 1024;

  /**
   * Start catching up, and make sure it cannot last for ever.
   *
   * The timer is the safety net rather than the mechanism. `reconciled()` is called by the daemon
   * when it has finished adopting and replaying, and this exists so that a daemon which never gets
   * there, through a bug or a failed adoption, ends up with a late terminal rather than a silent
   * one. Unref'd, so it is never the reason a process stays alive.
   */
  #reconcileTimer: NodeJS.Timeout | undefined;

  #beginReconciling(): void {
    this.#reconciling = true;
    this.#held = [];
    this.#heldBytes = 0;
    clearTimeout(this.#reconcileTimer);
    this.#reconcileTimer = setTimeout(() => {
      if (!this.#reconciling) return;
      warn('pty-host.reconcile-timeout', { heldBytes: this.#heldBytes });
      this.reconciled();
    }, PtyHostClient.RECONCILE_DEADLINE_MS);
    this.#reconcileTimer.unref();
  }

  /** How long catching up may take before output is released anyway. */
  static readonly RECONCILE_DEADLINE_MS = 5000;

  /** Hand on one frame, if it is genuinely new, and remember how far this session has come. */
  #deliver(sessionId: string, data: Buffer, seq: number): void {
    const through = this.#deliveredThrough.get(sessionId) ?? 0;
    // A replay always overlaps live output that arrived first. That overlap is not new bytes.
    if (seq <= through) return;
    this.#deliveredThrough.set(sessionId, seq);
    for (const fn of this.#dataListeners) fn(sessionId, data, seq);
  }

  /**
   * Catching up is over: merge what was held with what the replay delivered, and go live.
   *
   * Sorted by the host's sequence, which is the only ordering here that means anything, then
   * filtered by what has already been handed on, so a replay overlapping live output cannot
   * deliver the same bytes twice.
   */
  reconciled(): void {
    if (!this.#reconciling) return;
    this.#reconciling = false;
    clearTimeout(this.#reconcileTimer);
    const held = this.#held.sort((a, b) => a.seq - b.seq);
    this.#held = [];
    this.#heldBytes = 0;
    for (const frame of held) this.#deliver(frame.sessionId, frame.data, frame.seq);
  }

  /** Where a session's output has reached, for a daemon deciding what to ask for. */
  deliveredThrough(sessionId: string): number {
    return this.#deliveredThrough.get(sessionId) ?? 0;
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
          this.#beginReconciling();
          this.#attach(socket);
          const hello = await this.#request({ t: 'hello' }, 'hello-ok', 4000, true);
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
            /**
             * A host running a different binary than the one this daemon would start.
             *
             * Not an error and not fixed here: the host outlives updates on purpose, because
             * restarting it ends every terminal it holds. But it is worth saying, because the
             * consequence is invisible and confusing. macOS attaches privacy decisions to the
             * executable that asks, and this process is the one that spawns everybody's shells,
             * so a host still running the pre-update binary is why a permission prompt keeps
             * naming `node` after an update that was supposed to stop that.
             */
            const hostExec = typeof hello['execPath'] === 'string' ? hello['execPath'] : '';
            if (hostExec !== '' && hostExec !== process.execPath) {
              warn('pty-host.older-binary', {
                host: hostExec,
                daemon: process.execPath,
                note: 'the host predates this build and keeps its own identity until it is restarted, which ends its sessions',
              });
            }
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
    this.#state = 'handshaking';
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
          if (this.#reconciling) {
            this.#held.push({ sessionId: frame.frame.sessionId, data: buf, seq: frame.frame.seq });
            this.#heldBytes += buf.length;
            if (this.#heldBytes > PtyHostClient.HOLD_LIMIT_BYTES) {
              warn('pty-host.hold-overflow', { bytes: this.#heldBytes });
              this.reconciled();
            }
            continue;
          }
          this.#deliver(frame.frame.sessionId, buf, frame.frame.seq);
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
        /**
         * By id when the host sends one back, and by type when it does not.
         *
         * A host outlives the daemon by design, so one built before this change is a real thing
         * to meet: it echoes no id, and matching by type is exactly what it did before. The
         * oldest waiter for that type is the one that has been waiting longest, which is the
         * same answer the single-slot map used to give.
         */
        const id = typeof msg['requestId'] === 'string' ? msg['requestId'] : '';
        let key = id !== '' && this.#waiting.has(id) ? id : '';
        if (key === '') {
          for (const [candidate, waiter] of this.#waiting) {
            if (waiter.expect === t) {
              key = candidate;
              break;
            }
          }
        }
        const waiter = key === '' ? undefined : this.#waiting.get(key);
        if (waiter && waiter.expect === t) {
          this.#waiting.delete(key);
          waiter.resolve(msg);
        }
      }
    });

    socket.on('close', () => {
      this.#socket = null;
      this.#state = 'disconnected';
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
   * Bounded, because a host that never comes back must not turn into unbounded memory. What the
   * bound may throw away is the whole question, and it used to be "the oldest", which is close to
   * the worst possible answer: the oldest message for a session is its `spawn`, so a burst of
   * typing could evict the thing that creates the terminal those keystrokes are addressed to, and
   * a burst of resizes could evict the keystrokes. Either way the loss was silent, and a terminal
   * that accepts input and discards it is worse than one that refuses.
   *
   * So the bound is reached by throwing away what carries no information first, and never by
   * throwing away input.
   */
  #outbox: unknown[] = [];

  /**
   * Ordered input was lost, and the sessions it was lost for.
   *
   * Set only when coalescing has already run and the queue is still over its bound, which means
   * there is genuinely more typing held than may be kept. Nothing is quietly dropped on the
   * strength of it: the caller is told, and the terminal is told, because a hole in a keystroke
   * stream is not something a person can be left to discover.
   */
  #lostInputFor = new Set<string>();

  /** Sessions whose input was dropped while disconnected, taken and cleared. */
  takeLostInput(): string[] {
    const ids = [...this.#lostInputFor];
    this.#lostInputFor.clear();
    return ids;
  }

  /**
   * Send something that names a session, or hold it until there is a host to name it to.
   *
   * Held while handshaking as well as while disconnected. Those are the same situation from this
   * method's point of view: there is a socket in one of them, and in neither is it known whose.
   */
  #send(message: unknown): void {
    if (this.#state === 'ready' && this.#socket && !this.#socket.destroyed) {
      this.#socket.write(controlFrame(message));
      return;
    }
    this.#outbox.push(message);
    if (this.#outbox.length > OUTBOX_LIMIT) this.#trimOutbox();
  }

  /** See `trimOutbox`, which holds the judgement about what a bound may throw away. */
  #trimOutbox(): void {
    const { kept, lostInputFor } = trimOutbox(this.#outbox, OUTBOX_LIMIT);
    this.#outbox = kept;
    for (const id of lostInputFor) {
      this.#lostInputFor.add(id);
      warn('pty-host.outbox-input-dropped', { sessionId: id });
    }
  }

  /**
   * The handshake itself, which is the one thing that may be written to an unidentified host.
   *
   * It names no session and asks for nothing to be done. It is how the host is identified at all,
   * so holding it would leave the connection permanently in the state that holds everything.
   */
  #sendHandshake(message: unknown): boolean {
    if (!this.#socket || this.#socket.destroyed) return false;
    this.#socket.write(controlFrame(message));
    return true;
  }

  /**
   * Which host process we are talking to, once it has said.
   *
   * `null` until the first `hello` of this daemon's life. Compared on every reconnect, because
   * the whole question a reconnect raises is whether the terminals we were holding are still
   * there, and only the host can answer that.
   */
  /**
   * What this connection is good for right now.
   *
   * A socket is not a transport for anything that names a session. Between connecting and being
   * told which host answered there is a window, short but real, in which a spawn, a write, a
   * resize or a kill would go to a process nobody has identified: after a host has been replaced
   * that is a different host with different sessions, and one of those messages can be a kill.
   *
   * `handshaking` exists to make that window unusable rather than merely unlikely. Only the
   * handshake itself may be written in it.
   */
  #state: 'disconnected' | 'handshaking' | 'ready' = 'disconnected';

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
    /**
     * `gone` is the answer, and its absence is not a yes.
     *
     * A host too old to say carries no `gone` at all. Treating a missing field as success is the
     * same mistake as treating a queued frame as one, so only an explicit `true` confirms.
     */
    this.#killWaits.get(requestId)?.(msg['gone'] === true);
  }

  #identify(raw: unknown): void {
    const instance = typeof raw === 'string' && raw !== '' ? raw : null;
    const previous = this.#instance;
    this.#instanceChanged = previous !== null && instance !== previous;
    this.#instance = instance;

    if (instance === null) {
      /**
       * A host too old to say who it is.
       *
       * The connection is still used, because refusing it would strand every terminal that host
       * is holding, which is the outcome all of this exists to prevent. What is not used is
       * anything that was queued for a host we can no longer prove this is.
       */
      warn('pty-host.no-instance', {
        note: 'host too old to identify itself; nothing held will be sent to it',
      });
      this.#dropOutbox('unidentified-host');
      this.#state = 'ready';
      return;
    }
    if (this.#instanceChanged) {
      warn('pty-host.replaced', { was: previous, now: instance });
      this.#dropOutbox('host-replaced');
      this.#state = 'ready';
      return;
    }
    if (previous === null) info('pty-host.instance', { instance });
    this.#state = 'ready';
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
    /** Handshake traffic, which may go to a host that has not identified itself yet. */
    duringHandshake = false,
  ): Promise<Record<string, unknown> | null> {
    this.#nextRequestId += 1;
    const requestId = `r${String(this.#nextRequestId)}`;
    const withId = { ...(message as Record<string, unknown>), requestId };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.#waiting.set(requestId, {
        expect,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      if (duringHandshake) {
        if (!this.#sendHandshake(withId)) {
          clearTimeout(timer);
          this.#waiting.delete(requestId);
          resolve(null);
        }
        return;
      }
      this.#send(withId);
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

  /**
   * Tell the host a person closed this session's pane.
   *
   * The daemon decides it; the host keeps it, because it has to outlive the daemon. It is the
   * only thing that authorizes ending a session that is in no workspace, and a restart used to
   * lose it, which left the session alive and unreapable for good.
   */
  markPaneClosed(sessionId: string): void {
    this.#send({ t: 'mark', sessionId, paneClosedByUser: true });
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
   * Resolves true only when the host says the process is **gone**: it ran the escalation to
   * SIGKILL and then checked the pid. A host that had no such session answers gone as well, which
   * is truthful, since nothing is running there either way.
   *
   * Resolves false when nothing answered, when the answer was that the process survived, and when
   * there was no identified host to ask. All of them mean the daemon does not know that the
   * process has ended, and it must keep the record rather than quietly forgetting something that
   * may still be running with nothing able to see or reach it.
   */
  async killAndWait(sessionId: string, keepHistory = false, timeoutMs = 4000): Promise<boolean> {
    const requestId = randomUUID();
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#killWaits.delete(requestId);
        resolve(false);
      }, timeoutMs);
      this.#killWaits.set(requestId, (gone: boolean) => {
        clearTimeout(timer);
        this.#killWaits.delete(requestId);
        resolve(gone);
      });
    });
    /**
     * Not queued when there is nowhere to send it.
     *
     * A kill held in the outbox is aimed at a host that may be gone by the time anything is
     * flushed, and the caller is about to be told nothing happened, which is the truth.
     */
    /**
     * Only to a host that has said who it is.
     *
     * A kill held for later is a kill aimed at a process that may be gone by the time anything is
     * flushed, and a kill written during the handshake is a kill aimed at a host nobody has
     * identified. Both answer false, which the caller reads as "this did not happen" and which is
     * the truth.
     */
    if (this.#state !== 'ready' || !this.#socket || this.#socket.destroyed) {
      this.#killWaits.delete(requestId);
      return false;
    }
    this.#socket.write(controlFrame({ t: 'kill', sessionId, keepHistory, requestId }));
    return answered;
  }

  readonly #killWaits = new Map<string, (gone: boolean) => void>();

  /** Hand over screen state, so the next daemon can restore it exactly rather than approximately. */
  stash(sessionId: string, seq: number, state: string): void {
    this.#send({ t: 'stash', sessionId, seq, state });
  }

  /** Ask for everything after a sequence number. Output arrives through the data listeners. */
  /**
   * Ask for everything after a point, and say whether the host still had all of it.
   *
   * Returns the number of bytes that were asked for and could not be supplied. Zero is the
   * ordinary answer. Anything else means the host's ring had already dropped them, and whatever
   * screen is rebuilt from what arrived is missing a piece in the middle.
   */
  async replay(sessionId: string, fromSeq: number): Promise<{ missingBytes: number }> {
    const reply = await this.#request({ t: 'replay', sessionId, fromSeq }, 'replayed');
    const servableFrom = Number(reply?.['servableFrom']);
    if (!Number.isFinite(servableFrom)) return { missingBytes: 0 };
    return { missingBytes: Math.max(0, servableFrom - fromSeq) };
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}
