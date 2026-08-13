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

export class PtyHost {
  readonly #sessions = new Map<string, Live>();
  /** Per session, set by the daemon from the user's setting. */
  #ringBytes = RING_BYTES;
  readonly #clients = new Set<Socket>();
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #store: ScrollbackStore;

  constructor(socketPath: string, scrollbackDirectory: string) {
    this.#socketPath = socketPath;
    this.#server = createServer((socket) => this.#accept(socket));
    // The ring redraws a screen after the daemon restarts. This survives the host restarting
    // and the machine rebooting, which is the difference between a session and its history.
    this.#store = new ScrollbackStore({
      directory: scrollbackDirectory,
      budgetBytes: this.#ringBytes,
    });
    this.#store.prune();
  }

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
        resolve();
      });
    });
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  #accept(socket: Socket): void {
    this.#clients.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.#clients.delete(socket));

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
        if (f.kind === 'control') this.#handle(socket, f.message as Record<string, unknown>);
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
        this.#send(socket, { t: 'hello-ok', protocol: HOST_PROTOCOL, pid: process.pid });
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
        this.#send(socket, { t: 'replayed', sessionId: id, seq: live.seq });
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
        if (!live) return;
        this.#sessions.delete(id);
        void killPty(live.handle, id);
        // The process is gone on purpose, so its history goes with it. Ending a session and
        // leaving its output on disk would be a surprise in the wrong direction.
        this.#store.clear(id);
        return;
      }

      default:
        return;
    }
  }

  #wire(live: Live): void {
    live.handle.pty.onData((chunk) => {
      const data = Buffer.from(chunk, 'binary');
      live.seq += data.length;
      const copy = new Uint8Array(data);
      this.#store.append(live.id, copy);
      live.ring.push({ seq: live.seq, data: copy });
      live.ringBytes += copy.length;
      // Dropped from the front, because the recent past is what redraws a screen.
      while (live.ringBytes > this.#ringBytes && live.ring.length > 1) {
        const dropped = live.ring.shift();
        live.ringBytes -= dropped?.data.length ?? 0;
      }
      this.#broadcast(outputFrame({ sessionId: live.id, seq: live.seq, data: copy }));
    });

    live.handle.pty.onExit(({ exitCode, signal }) => {
      live.exited = { exitCode, ...(signal !== undefined ? { signal } : {}) };
      this.#sessions.delete(live.id);
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
    for (const c of this.#clients) c.destroy();
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
  }
}
