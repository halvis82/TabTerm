import { killPty, spawnPty, type PtyHandle } from './pty-manager.js';

/**
 * Where a PTY actually lives.
 *
 * Two implementations, for one reason each.
 *
 * `HostPtyBackend` puts every PTY in a separate process, so replacing the daemon does not end
 * anybody's terminal. That is the one that ships and the reason this seam exists at all.
 *
 * `LocalPtyBackend` keeps them in the daemon, the way it worked before. It is the fallback when
 * the host cannot be started, because a TabTerm that runs without surviving updates is better
 * than one that does not run, and it is what the tests use, because a unit test should not need
 * a background process to be alive on the machine.
 *
 * See docs/adr/0017.
 */

export interface PtySpawnRequest {
  sessionId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  command?: readonly string[];
  env?: Record<string, string>;
}

export interface PtyBackend {
  /**
   * Start a PTY. Deliberately not async.
   *
   * The control handler that calls this is synchronous, and messages from one client are
   * handled strictly in order. Making creation await a round trip would let a later message
   * overtake an earlier one, so "create then write" could arrive as "write then create".
   * Ordering is instead guaranteed by the transport, and the pid arrives through `onSpawned`.
   */
  spawn(req: PtySpawnRequest): void;
  /** The pid, once whatever owns the PTY has one. */
  onSpawned(fn: (sessionId: string, pid: number) => void): void;
  write(sessionId: string, data: string): void;
  /** Output that did not come from the process. Never reaches the shell. */
  inject(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  /** `keepHistory` when nobody asked for this, so a tab still open has something to show. */
  kill(sessionId: string, keepHistory?: boolean): Promise<void>;
  /** Output. Always delivered, never paused: invariant 3. */
  onData(fn: (sessionId: string, data: Buffer) => void): void;
  onExit(fn: (sessionId: string, exitCode: number, signal?: number) => void): void;
  /** Sessions that already exist, which is empty for anything that cannot outlive the daemon. */
  adoptable(): Promise<{ sessionId: string; pid: number; cwd: string; seq: number }[]>;
  close(): void;
}

export class LocalPtyBackend implements PtyBackend {
  readonly #handles = new Map<string, PtyHandle>();
  #onData: (sessionId: string, data: Buffer) => void = () => {};
  #onExit: (sessionId: string, exitCode: number, signal?: number) => void = () => {};

  #onSpawned: (sessionId: string, pid: number) => void = () => {};

  spawn(req: PtySpawnRequest): void {
    const handle = spawnPty({
      sessionId: req.sessionId,
      shell: req.shell,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      ...(req.command ? { command: req.command } : {}),
      ...(req.env ? { env: req.env } : {}),
    });
    this.#handles.set(req.sessionId, handle);

    handle.pty.onData((chunk) => this.#onData(req.sessionId, Buffer.from(chunk, 'utf8')));
    handle.pty.onExit(({ exitCode, signal }) => {
      this.#handles.delete(req.sessionId);
      this.#onExit(req.sessionId, exitCode, signal);
    });
    this.#onSpawned(req.sessionId, handle.pid);
  }

  onSpawned(fn: (sessionId: string, pid: number) => void): void {
    this.#onSpawned = fn;
  }

  write(sessionId: string, data: string): void {
    this.#handles.get(sessionId)?.pty.write(data);
  }

  /**
   * Straight to the listener, because there is no ring here to put it in.
   *
   * The local backend keeps nothing beyond the process, so injected output reaches the screen
   * and nothing else. That is the honest behavior for a backend whose whole point is that it
   * does not outlive the daemon.
   */
  inject(sessionId: string, data: string): void {
    this.#onData(sessionId, Buffer.from(data, 'utf8'));
  }

  resize(sessionId: string, cols: number, rows: number): void {
    try {
      this.#handles.get(sessionId)?.pty.resize(cols, rows);
    } catch {
      // Exited between the lookup and the call.
    }
  }

  async kill(sessionId: string): Promise<void> {
    const handle = this.#handles.get(sessionId);
    if (!handle) return;
    this.#handles.delete(sessionId);
    await killPty(handle, sessionId);
  }

  onData(fn: (sessionId: string, data: Buffer) => void): void {
    this.#onData = fn;
  }

  onExit(fn: (sessionId: string, exitCode: number, signal?: number) => void): void {
    this.#onExit = fn;
  }

  /** Nothing. A PTY in this process cannot have outlived this process. */
  adoptable(): Promise<{ sessionId: string; pid: number; cwd: string; seq: number }[]> {
    return Promise.resolve([]);
  }

  /**
   * Kill everything.
   *
   * Correct **here** and nowhere else: these PTYs are children of a process that is ending, so
   * they are going to die whatever this method does. Leaving them would orphan them with no
   * handle and no way to reach them again. The host backend deliberately does the opposite.
   */
  close(): void {
    for (const [id, handle] of this.#handles) void killPty(handle, id);
    this.#handles.clear();
  }
}
