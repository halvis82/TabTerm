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

  inject(sessionId: string, data: string): void {
    this.#client.inject(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#client.resize(sessionId, cols, rows);
  }

  /**
   * End a session, and wait for the host to say it did.
   *
   * Killing is still explicit and still happens: a session that expires, or that somebody closes,
   * is ended. What changed is that this no longer reports success for having put a frame on a
   * socket. Throws when nothing answered, so the caller keeps its record of a process it cannot
   * account for rather than forgetting one that may still be running.
   */
  async kill(sessionId: string, keepHistory = false): Promise<void> {
    const acknowledged = await this.#client.killAndWait(sessionId, keepHistory);
    if (!acknowledged) throw new Error(`the PTY host did not acknowledge ending ${sessionId}`);
  }

  onData(fn: (sessionId: string, data: Buffer) => void): void {
    this.#client.onData((sessionId, data) => fn(sessionId, data));
  }

  onExit(fn: (sessionId: string, exitCode: number, signal?: number) => void): void {
    this.#client.onExit(fn);
  }

  async adoptable(): Promise<
    {
      sessionId: string;
      pid: number;
      cwd: string;
      seq: number;
      startedAt?: number;
      cols?: number;
      rows?: number;
      hasInput?: boolean;
      paneClosedByUser?: boolean;
    }[]
  > {
    const sessions = await this.#client.list();
    return sessions
      .filter((s) => s.alive)
      .map((s) => ({
        sessionId: s.sessionId,
        pid: s.pid,
        cwd: s.cwd,
        seq: s.seq,
        startedAt: s.startedAt,
        // The host has held the real size all along. It was being thrown away here.
        ...(typeof s.cols === 'number' && typeof s.rows === 'number'
          ? { cols: s.cols, rows: s.rows }
          : {}),
        // Whether anybody has typed into it, which only the host has kept across the restart.
        ...(s.hasInput === true ? { hasInput: true } : {}),
        ...(s.paneClosedByUser === true ? { paneClosedByUser: true } : {}),
      }));
  }

  /** See `PtyHostClient.markPaneClosed`. The host keeps it; this daemon may not be here later. */
  markPaneClosed(sessionId: string): void {
    this.#client.markPaneClosed(sessionId);
  }

  /** Ask for everything after a sequence number, so a restarted daemon can rebuild a screen. */
  /** See `PtyHostClient.replay`. Reports how much of what was asked for could not be supplied. */
  replay(sessionId: string, fromSeq: number): Promise<{ missingBytes: number }> {
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
