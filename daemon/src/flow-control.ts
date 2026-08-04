/**
 * Per-stream credit window and output coalescing.
 *
 * Measured: the loopback socket sustains 1,783 MB/s while the VT parser sustains 50 MB/s, so
 * the transport has roughly 35x the headroom. This window is therefore not protecting the
 * socket. It protects the frontend renderer, which is the slowest consumer in the chain.
 * See docs/11-performance.md.
 */
export interface FlowOptions {
  windowBytes: number;
  coalesceMs: number;
  maxChunkBytes: number;
  /** Called when a batch is ready to go on the wire. */
  send: (chunk: Buffer) => void;
  /** Called when the client fell so far behind that a fresh snapshot beats a backlog replay. */
  onDesync: () => void;
}

/** Backlog, in credit windows, at which a stalled client gets a snapshot instead of a replay. */
const DESYNC_WINDOWS = 4;

export class FlowController {
  readonly #opts: FlowOptions;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #outstanding = 0;
  #timer: NodeJS.Timeout | null = null;
  #desynced = false;

  constructor(opts: FlowOptions) {
    this.#opts = opts;
  }

  /**
   * Queue output. Never blocks and never applies backpressure upstream, because the daemon
   * must keep draining the PTY regardless of how slow this client is.
   */
  push(data: Buffer): void {
    if (this.#desynced) return; // Already going to resync with a snapshot.

    this.#pending.push(data);
    this.#pendingBytes += data.length;

    // Desync only when the client is genuinely behind, meaning its window is full AND the
    // backlog has grown past the threshold. A single large write from a fast producer is not
    // a desync: an idle client can absorb it in chunks over the next few flushes.
    //
    // Terminals are idempotent on redraw, so a truly stuck client gets a fresh snapshot
    // rather than a replay. Nobody needs to watch a 500 MB cat scroll past in real time.
    const behind = this.#outstanding >= this.#opts.windowBytes;
    if (behind && this.#pendingBytes > this.#opts.windowBytes * DESYNC_WINDOWS) {
      this.#discard();
      this.#desynced = true;
      this.#opts.onDesync();
      return;
    }

    this.#schedule();
  }

  ack(bytes: number): void {
    this.#outstanding = Math.max(0, this.#outstanding - bytes);
    this.#schedule();
  }

  /** Called after a snapshot has been delivered, so streaming can resume cleanly. */
  resync(): void {
    this.#discard();
    this.#desynced = false;
    this.#outstanding = 0;
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#discard();
  }

  #schedule(): void {
    if (this.#timer || this.#pending.length === 0) return;
    if (this.#outstanding >= this.#opts.windowBytes) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, this.#opts.coalesceMs);
  }

  #flush(): void {
    while (this.#pending.length > 0 && this.#outstanding < this.#opts.windowBytes) {
      const budget = Math.min(this.#opts.maxChunkBytes, this.#opts.windowBytes - this.#outstanding);
      const chunk = this.#take(budget);
      if (chunk.length === 0) break;
      this.#outstanding += chunk.length;
      this.#opts.send(chunk);
    }
    this.#schedule();
  }

  #take(budget: number): Buffer {
    const out: Buffer[] = [];
    let taken = 0;
    while (this.#pending.length > 0 && taken < budget) {
      const head = this.#pending[0] as Buffer;
      const room = budget - taken;
      if (head.length <= room) {
        out.push(head);
        taken += head.length;
        this.#pending.shift();
      } else {
        out.push(head.subarray(0, room));
        this.#pending[0] = head.subarray(room);
        taken += room;
      }
    }
    this.#pendingBytes -= taken;
    return out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out);
  }

  #discard(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
  }
}
