import type { PtyBackend, PtySpawnRequest } from '../pty-backend.js';
import type { PtyHostClient } from './client.js';

/**
 * The PTY backend that survives a daemon restart.
 *
 * A thin adapter: everything interesting is in the host process and its client. What is worth
 * reading here is `close`, which does nothing to any process, and is the exact opposite of the
 * local backend's `close`. That difference is the feature.
 */
export class HostPtyBackend implements PtyBackend {
  readonly #client: PtyHostClient;

  constructor(client: PtyHostClient) {
    this.#client = client;
  }

  spawn(req: PtySpawnRequest): void {
    this.#client.spawn(req);
  }

  onSpawned(fn: (sessionId: string, pid: number) => void): void {
    this.#client.onSpawned(fn);
  }

  write(sessionId: string, data: string): void {
    this.#client.write(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#client.resize(sessionId, cols, rows);
  }

  kill(sessionId: string): Promise<void> {
    // Killing is still explicit and still happens: a session that expires, or that somebody
    // closes, is ended. What changed is that stopping the daemon is no longer one of those.
    this.#client.kill(sessionId);
    return Promise.resolve();
  }

  onData(fn: (sessionId: string, data: Buffer) => void): void {
    this.#client.onData((sessionId, data) => fn(sessionId, data));
  }

  onExit(fn: (sessionId: string, exitCode: number, signal?: number) => void): void {
    this.#client.onExit(fn);
  }

  async adoptable(): Promise<{ sessionId: string; pid: number; cwd: string; seq: number }[]> {
    const sessions = await this.#client.list();
    return sessions
      .filter((s) => s.alive)
      .map((s) => ({ sessionId: s.sessionId, pid: s.pid, cwd: s.cwd, seq: s.seq }));
  }

  /** Ask for everything after a sequence number, so a restarted daemon can rebuild a screen. */
  replay(sessionId: string, fromSeq: number): Promise<void> {
    return this.#client.replay(sessionId, fromSeq);
  }

  /**
   * Let go of the socket. Touch nothing else.
   *
   * The daemon is stopping, and every terminal keeps running. This is the whole point of the
   * work package, and it is one line.
   */
  close(): void {
    this.#client.close();
  }
}
