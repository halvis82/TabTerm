import { randomUUID } from 'node:crypto';
import { warn } from '../log.js';
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { killPty, spawnPty, type PtyHandle, type PtyOptions } from '../pty-manager.js';
import { controlFrame, decodeFrames, outputFrame } from './framing.js';
import { ScrollbackStore } from './scrollback-store.js';

/**
 * The process that owns every PTY, and nothing else.
 *
 * It exists so that updating TabTerm does not kill your terminals. Previously the daemon owned
 * the PTYs directly, and every restart called `killPty` on all of them, so shipping a change
 * meant destroying every running process and every screen of output. That is the single reason
 * the product could not be trusted for real work. See docs/adr/0017.
 *
 * The rule that makes this work is that **this process is boring**. It holds file descriptors
 * and bytes. It has no database, no protocol version negotiated with a browser, no policy, and
 * no reason to change when a feature is added. The daemon is where change lives, and the daemon
 * is now disposable.
 *
 * Invariant 3 still holds and is now this process's job: the PTY is always drained, never
 * paused, whatever the daemon is doing. A daemon that is restarting, wedged, or absent must not
 * be able to apply backpressure to somebody's build.
 */

export const HOST_PROTOCOL = 1;

/** How often a running host tidies scrollback it no longer needs. See the constructor. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Who this host is, for as long as this process lives.
 *
 * A socket is not an identity. A daemon that loses its connection and gets another one has proved
 * only that it has a connection, and the two questions it actually needs answered are different:
 * is this the same host that was holding my terminals, or a new one that never had them?
 *
 * Answering that from "the socket came back" is how a recoverable interruption becomes a reason
 * to end every session in it. The instance is generated once, at startup, and never changes.
 */
export const HOST_INSTANCE = randomUUID();

interface Live {
  id: string;
  handle: PtyHandle;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  seq: number;
  /** Recent output, so a restarted daemon can rebuild its screen. Bounded, see RING_BYTES. */
  ring: { seq: number; data: Uint8Array }[];
  ringBytes: number;
  /** VT state the daemon handed over before it stopped, with the seq it was accurate at. */
  stash?: { seq: number; state: string };
  exited?: { exitCode: number; signal?: number };
}

/**
 * Enough to redraw a screen and a healthy scrollback, per session, in memory.
 *
 * This is the recovery buffer, not the history. Durable history is a separate concern and lives
 * on disk. What this has to guarantee is that a daemon which restarts can show you a correct
 * screen rather than a plausible one.
 */
const RING_BYTES = 5 * 1024 * 1024;

/**
 * The most sessions this process will hold at once.
 *
 * A last line of defence, and the only place that can be one: this process is the only thing
 * that knows the total, because the daemon can be replaced and Chrome can be closed while these
 * keep running.
 *
 * macOS hands out a fixed number of pseudo-terminals, `kern.tty.ptmx_max`, which is 511 by
 * default. Reaching it does not degrade this product, it stops every terminal on the machine:
 * iTerm included, with an opaque `posix_spawnp failed` that names nothing. That happened on
 * 2026-09-02 and cost an afternoon. See docs/10-limitations.md.
 *
 * A hundred is far above any honest use and far below the point of no return. Somebody with a
 * hundred live terminals has a runaway, and being told so is more useful than being handed the
 * hundred and first.
 *
 * Deliberately not a user setting. A number you can raise from a preferences pane while
 * something is spawning in a loop is not a safety limit. It is a constructor argument so that a
 * test can prove the limit works without opening a hundred shells to do it, which would be a
 * test about opening too many shells that occasionally breaks the machine it runs on.
 */
const MAX_SESSIONS = 100;

/**
 * How long a host with nothing to hold waits before leaving.
 *
 * Generous, because the case it must not get wrong is a daemon being replaced: it disconnects
 * and comes back within seconds, and a host that left in that gap would take every terminal with
 * it. Two minutes is far longer than any restart and far shorter than a day of leaking.
 */
const IDLE_EXIT_MS = 120_000;

export class PtyHost {
  readonly #sessions = new Map<string, Live>();
  /** Per session, set by the daemon from the user's setting. */
  #ringBytes = RING_BYTES;
  readonly #clients = new Set<Socket>();
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #store: ScrollbackStore;
  readonly #maxSessions: number;

  /**
   * What to do when this host is holding nothing for nobody, or nothing at all.
   *
   * Injected rather than calling `process.exit` directly, because a host embedded in another
   * process must never end it. The standalone entrypoint is the only caller that passes one, and
   * every test constructs a host that simply stays.
   */
  readonly #onIdle: (() => void) | undefined;

  constructor(
    socketPath: string,
    scrollbackDirectory: string,
    maxSessions = MAX_SESSIONS,
    onIdle?: () => void,
  ) {
    this.#maxSessions = maxSessions;
    this.#onIdle = onIdle;
    this.#socketPath = socketPath;
    this.#server = createServer((socket) => this.#accept(socket));
    // The ring redraws a screen after the daemon restarts. This survives the host restarting
    // and the machine rebooting, which is the difference between a session and its history.
    this.#store = new ScrollbackStore({
      directory: scrollbackDirectory,
      budgetBytes: this.#ringBytes,
    });
    this.#store.prune();
    /**
     * And again while it runs, because this process is meant to run for months.
     *
     * Pruning only at startup means never pruning: the host survives daemon updates, browser
     * restarts and everything else by design, so the one moment it tidies up is the one moment it
     * has nothing to tidy. Found with 1051 files and 83 MB under a host that had been running for
     * three days, with the oldest file three weeks old and nothing coming to remove it.
     *
     * Daily, and unref'd: a timer for housekeeping must never be the reason this process stays
     * alive, and must never be the reason it is busy either.
     */
    this.#pruneTimer = setInterval(() => this.#store.prune(), PRUNE_EVERY_MS);
    this.#pruneTimer.unref();
  }

  #pruneTimer: NodeJS.Timeout | undefined;

  listen(): Promise<void> {
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    // A socket left by a host that died is not a host. Removing it is safe precisely because
    // the lock is held elsewhere: two hosts cannot reach this line at once.
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#socketPath, () => {
        // Owner only. Anything that can open this socket can spawn a process as you.
        chmodSync(this.#socketPath, 0o600);
        // A host nobody ever connects to is the third way one is left behind: a daemon that
        // spawned it and then died before saying hello.
        this.#leaveIfNothingLeft();
        resolve();
      });
    });
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * Leave when there is nothing left to hold and nobody left to hold it for.
   *
   * This process exists to outlive its daemon, which is exactly why it cannot be ended along
   * with one. That is right while it holds terminals, and pointless when it holds none: a host
   * with no sessions and no daemon is protecting nothing, and a test run that was killed leaves
   * one behind every time. 133 of them were counted on 2026-09-04.
   *
   * Both conditions, and a delay, because a daemon being replaced is the ordinary case: it
   * disconnects and reconnects within seconds, and the host must still be here when it does.
   */
  #idleTimer?: ReturnType<typeof setTimeout>;

  #leaveIfNothingLeft(): void {
    clearTimeout(this.#idleTimer);
    const leave = this.#onIdle;
    if (!leave || this.#clients.size > 0 || this.#sessions.size > 0) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#clients.size > 0 || this.#sessions.size > 0) return;
      leave();
    }, IDLE_EXIT_MS);
    // Nothing here should keep the process alive on its own account.
    this.#idleTimer.unref?.();
  }

  #accept(socket: Socket): void {
    this.#clients.add(socket);
    clearTimeout(this.#idleTimer);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.#clients.delete(socket);
      this.#leaveIfNothingLeft();
    });

    let pending = new Uint8Array(0);
    socket.on('data', (chunk: Buffer) => {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let decoded;
      try {
        decoded = decodeFrames(merged);
      } catch {
        // A malformed stream is not recoverable by guessing where the next frame starts.
        socket.destroy();
        return;
      }
      const { frames, consumed } = decoded;
      pending = merged.subarray(consumed);
      for (const f of frames) {
        if (f.kind !== 'control') continue;
        try {
          this.#handle(socket, f.message as Record<string, unknown>);
        } catch (e: unknown) {
          /**
           * One bad message must not disturb anything else this process is holding.
           *
           * There is a guard for uncaught exceptions, but reaching it means unwinding out of a
           * socket handler with the rest of this batch unprocessed. This process holds the only
           * handle to everybody's running work, so a message it cannot make sense of is
           * answered by ignoring that message and nothing more.
           */
          this.#send(socket, {
            t: 'message-failed',
            message: String(e),
            about: f.message,
          });
        }
      }
    });
  }

  #send(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(controlFrame(message));
  }

  #broadcast(payload: Uint8Array): void {
    for (const c of this.#clients) if (!c.destroyed) c.write(payload);
  }

  #handle(socket: Socket, msg: Record<string, unknown>): void {
    const t = msg['t'];
    const id = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';

    switch (t) {
      case 'hello':
        this.#send(socket, {
          t: 'hello-ok',
          protocol: HOST_PROTOCOL,
          pid: process.pid,
          instance: HOST_INSTANCE,
          /**
           * Which binary is running this host, so a daemon can tell whether it is the one it
           * would start itself.
           *
           * macOS attaches a privacy decision to the executable that asks for it, and this
           * process is the one that spawns everybody's shells, so it is the one macOS asks about.
           * A host started before an update runs the old binary for as long as it lives, which is
           * by design: it is never restarted, because restarting it ends every terminal it holds.
           */
          execPath: process.execPath,
        });
        return;

      case 'list':
        this.#send(socket, {
          t: 'sessions',
          sessions: [...this.#sessions.values()].map((s) => ({
            sessionId: s.id,
            pid: s.handle.pid,
            cwd: s.cwd,
            cols: s.cols,
            rows: s.rows,
            startedAt: s.startedAt,
            seq: s.seq,
            alive: s.exited === undefined,
            ...(s.stash ? { stash: s.stash } : {}),
          })),
        });
        return;

      case 'spawn': {
        if (this.#sessions.has(id)) {
          this.#send(socket, {
            t: 'spawned',
            sessionId: id,
            pid: this.#sessions.get(id)?.handle.pid,
          });
          return;
        }
        if (this.#sessions.size >= this.#maxSessions) {
          this.#send(socket, {
            t: 'spawn-failed',
            sessionId: id,
            error:
              `${String(this.#maxSessions)} terminals are already running, which is the most ` +
              'TabTerm ' +
              'will hold. Close some, or restart the machine if they are not yours. The limit ' +
              'exists because macOS stops every terminal on the machine, in every application, ' +
              'once it runs out of pseudo-terminals.',
          });
          return;
        }
        try {
          const opts = msg['options'] as PtyOptions;
          const handle = spawnPty(opts);
          const live: Live = {
            id,
            handle,
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
            startedAt: Date.now(),
            seq: 0,
            ring: [],
            ringBytes: 0,
          };
          this.#sessions.set(id, live);
          this.#wire(live);
          this.#send(socket, { t: 'spawned', sessionId: id, pid: handle.pid });
        } catch (e: unknown) {
          this.#send(socket, { t: 'spawn-failed', sessionId: id, error: String(e) });
        }
        return;
      }

      case 'inject': {
        /**
         * Output that did not come from the process.
         *
         * Deliberately not a `write`: this must never reach the shell. It goes through the same
         * path real output takes, so it lands in the ring, on disk, and on every attached
         * screen, and therefore survives a reload and a daemon restart like anything else the
         * terminal has printed. See docs/07-terminal-fidelity.md.
         */
        const live = this.#sessions.get(id);
        if (!live || typeof msg['data'] !== 'string') return;
        this.#emit(live, Buffer.from(msg['data'], 'utf8'));
        return;
      }

      case 'write': {
        const live = this.#sessions.get(id);
        if (live && typeof msg['data'] === 'string') live.handle.pty.write(msg['data']);
        return;
      }

      case 'resize': {
        const live = this.#sessions.get(id);
        const cols = Number(msg['cols']);
        const rows = Number(msg['rows']);
        if (!live || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
        live.cols = cols;
        live.rows = rows;
        try {
          live.handle.pty.resize(cols, rows);
        } catch {
          // A process that exited between the check and the call. Not worth reporting.
        }
        return;
      }

      case 'stash': {
        // The daemon's screen state, handed over before it stops. Replaying bytes alone can
        // only approximate a screen, because the buffer may not begin at a state boundary.
        const live = this.#sessions.get(id);
        if (live && typeof msg['state'] === 'string') {
          live.stash = { seq: Number(msg['seq']) || live.seq, state: msg['state'] };
        }
        return;
      }

      case 'replay': {
        // Everything after a sequence number, so a reconnecting daemon gets exactly the gap.
        const live = this.#sessions.get(id);
        if (!live) return;
        const from = Number(msg['fromSeq']) || 0;
        for (const chunk of live.ring) {
          if (chunk.seq > from && !socket.destroyed) {
            socket.write(outputFrame({ sessionId: id, seq: chunk.seq, data: chunk.data }));
          }
        }
        /**
         * And the earliest byte this ring can still serve, so a gap can be seen.
         *
         * The ring is dropped from the front when it grows past its budget. A daemon that was
         * away long enough for a busy session to overflow it asks for bytes that are no longer
         * here, and gets what is left with no sign that anything is missing: the screen it
         * rebuilds is then wrong in a way nothing can detect, which for a terminal whose promise
         * is the exact screen is the worst kind of wrong.
         *
         * A chunk's `seq` is the byte count **after** it, so the first byte it carries is
         * `seq - length`, and the oldest chunk's is the earliest this can answer for.
         */
        const oldest = live.ring[0];
        const servableFrom = oldest ? oldest.seq - oldest.data.length : live.seq;
        this.#send(socket, {
          t: 'replayed',
          sessionId: id,
          seq: live.seq,
          servableFrom,
        });
        return;
      }

      case 'clear': {
        // The buffer that survives a daemon restart. Clearing that has to include this, or the
        // output comes back the next time anything reconnects.
        const live = this.#sessions.get(id);
        if (live) {
          live.ring = [];
          live.ringBytes = 0;
          delete live.stash;
        }
        // On disk too, or clearing is only true until something reads the history back.
        this.#store.clear(id);
        return;
      }

      case 'budget': {
        // One number governs every copy of the scrollback, so raising it means more history
        // actually survives an update rather than only more being visible now.
        const bytes = Number(msg['bytes']);
        if (Number.isFinite(bytes) && bytes > 0) {
          this.#ringBytes = Math.floor(bytes);
          this.#store.setBudget(this.#ringBytes);
        }
        return;
      }

      case 'history': {
        // Everything kept for a session, even one whose process is long gone. This is what an
        // expired tab can offer instead of an apology.
        const data = this.#store.read(id);
        if (!socket.destroyed && data.length > 0) {
          socket.write(outputFrame({ sessionId: id, seq: 0, data }));
        }
        this.#send(socket, { t: 'history-end', sessionId: id, bytes: data.length });
        return;
      }

      case 'usage': {
        this.#send(socket, { t: 'usage', ...this.#store.usage() });
        return;
      }

      case 'kill': {
        const live = this.#sessions.get(id);
        /**
         * Answered either way, including when there was nothing to kill.
         *
         * A destructive operation that is only a frame put on a socket is a guess about reality.
         * The daemon lets go of its record of a session once this arrives, and without it that
         * record was dropped the moment the frame was queued, which after a disconnect means a
         * process still running that nothing can see or reach.
         */
        const requestId = typeof msg['requestId'] === 'string' ? msg['requestId'] : '';
        const answer = (existed: boolean, gone: boolean): void => {
          if (requestId !== '') {
            this.#send(socket, { t: 'killed', requestId, sessionId: id, existed, gone });
          }
        };
        if (!live) {
          // Nothing here to end, which is a truthful confirmation that nothing is running.
          answer(false, true);
          return;
        }
        /**
         * Answered when the process is gone, not when the signalling starts.
         *
         * The escalation runs to SIGKILL and then asks whether the pid is still there, and that
         * answer is the one the daemon needs: it discards its record of a session on the strength
         * of this reply, and a reply meaning "termination was begun" lets it forget a process that
         * is still running. Nothing could then see, reach or end that process.
         *
         * The session leaves the map only once the answer is `gone`. The ordinary `onExit` path
         * may get there first, which is harmless: deleting twice does nothing, and the exit is
         * announced by whichever notices, once.
         */
        void (async () => {
          const outcome = await killPty(live.handle, id);
          if (outcome === 'gone') this.#sessions.delete(id);
          else warn('pty-host.kill-unconfirmed', { sessionId: id, pid: live.handle.pid });
          answer(true, outcome === 'gone');
        })();
        /**
         * Whether the output goes with it depends on who ended it.
         *
         * Somebody who closes a session meant to be rid of it, so leaving its output on disk
         * would be a surprise in the wrong direction. A session ended by a timeout was not
         * closed by anybody, and its tab may still be open, so its history is what that tab has
         * left to show. See docs/07-terminal-fidelity.md.
         */
        if (msg['keepHistory'] !== true) this.#store.clear(id);
        return;
      }

      default:
        return;
    }
  }

  /** Everything a session has printed goes through here, whatever produced it. */
  /**
   * Output from a terminal, sent on before it is written down.
   *
   * Everything here has to happen, and only one of them is between the process and the person
   * looking at it. Keeping history meant a blocking write to disk on every chunk, measured at
   * about a fifth of a millisecond each, in front of the bytes rather than behind them: a person
   * scrolling a program that redraws waits for the disk on every frame, for no reason, since
   * nothing reads that file until a session is adopted after a restart.
   *
   * The order the store and the ring see is unchanged, because this is still one call per chunk
   * in the order they arrived.
   */
  #emit(live: Live, data: Buffer): void {
    live.seq += data.length;
    const copy = new Uint8Array(data);
    this.#broadcast(outputFrame({ sessionId: live.id, seq: live.seq, data: copy }));

    this.#store.append(live.id, copy);
    live.ring.push({ seq: live.seq, data: copy });
    live.ringBytes += copy.length;
    // Dropped from the front, because the recent past is what redraws a screen.
    while (live.ringBytes > this.#ringBytes && live.ring.length > 1) {
      const dropped = live.ring.shift();
      live.ringBytes -= dropped?.data.length ?? 0;
    }
  }

  #wire(live: Live): void {
    /**
     * UTF-8, because that is what node-pty decoded it from.
     *
     * This was `'binary'`, which is Latin-1: it keeps the low byte of every code unit and throws
     * the rest away. Every character above U+00FF came out as rubbish, and the rubbish was
     * specific enough to identify on sight. A box drawn with `╭─╮ │ ╰╯` arrived as `m`, nothing,
     * `n`, nothing, `p`, `o`, because those are the low bytes of U+256D, U+2500, U+256E, U+2502,
     * U+2570 and U+256F. Claude Code's `✻` became `;` for the same reason, U+273B.
     *
     * So no terminal user interface has ever drawn correctly through the PTY host, and no accent
     * or emoji has ever survived it. It went unseen because the local backend, which the browser
     * suites used until the host's socket path was fixed, has always encoded this correctly.
     */
    live.handle.pty.onData((chunk) => this.#emit(live, Buffer.from(chunk, 'utf8')));

    live.handle.pty.onExit(({ exitCode, signal }) => {
      live.exited = { exitCode, ...(signal !== undefined ? { signal } : {}) };
      this.#sessions.delete(live.id);
      // The last terminal ending, with no daemon to tell, is the other way this becomes a
      // process holding nothing for nobody.
      this.#leaveIfNothingLeft();
      for (const c of this.#clients) {
        this.#send(c, { t: 'exited', sessionId: live.id, exitCode, signal });
      }
    });
  }

  /**
   * Stop serving, without touching a single process.
   *
   * That distinction is the entire point of this file. Shutting down means letting go of a
   * socket, not ending anybody's work.
   */
  async close(): Promise<void> {
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    for (const c of this.#clients) c.destroy();
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
  }
}
