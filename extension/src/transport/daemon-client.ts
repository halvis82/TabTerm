import {
  PROTOCOL_VERSION,
  ackFrame,
  controlFrame,
  decodeFrame,
  inputFrame,
  type ClientMessage,
  type ServerMessage,
} from '@tabterm/shared';

/**
 * A connection to the daemon.
 *
 * Terminal pages hold their own data connection so its lifetime matches the renderer that
 * consumes it. The offscreen document holds the control connection because neither the
 * service worker nor a terminal page can survive long enough.
 * See docs/01-architecture.md.
 */
export interface DaemonClientOptions {
  port: number;
  token: string;
  clientId: string;
  role: 'control' | 'data';
  onControl: (msg: ServerMessage) => void;
  onOutput: (streamId: number, data: Uint8Array) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export type ConnectionStatus = 'connecting' | 'authenticating' | 'ready' | 'retrying' | 'closed';

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 10_000;

export class DaemonClient {
  #ws: WebSocket | null = null;
  #opts: DaemonClientOptions;
  #backoff = BACKOFF_MIN_MS;
  #stopped = false;
  #ready = false;

  constructor(opts: DaemonClientOptions) {
    this.#opts = opts;
  }

  get ready(): boolean {
    return this.#ready;
  }

  connect(): void {
    if (this.#stopped) return;
    this.#opts.onStatus('connecting');

    const ws = new WebSocket(`ws://127.0.0.1:${String(this.#opts.port)}`);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.onopen = () => {
      this.#opts.onStatus('authenticating');
      ws.send(
        controlFrame({
          t: 'auth',
          v: PROTOCOL_VERSION,
          role: this.#opts.role,
          token: this.#opts.token,
          clientId: this.#opts.clientId,
        }),
      );
    };

    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const frame = decodeFrame(new Uint8Array(ev.data));
      if (frame.kind === 'control') {
        if (frame.message.t === 'auth-ok') {
          this.#ready = true;
          this.#backoff = BACKOFF_MIN_MS;
          this.#opts.onStatus('ready');
        }
        this.#opts.onControl(frame.message as ServerMessage);
        return;
      }
      if (frame.kind === 'output') {
        this.#opts.onOutput(frame.streamId, frame.data);
      }
    };

    ws.onclose = () => {
      this.#ready = false;
      this.#ws = null;
      if (this.#stopped) {
        this.#opts.onStatus('closed');
        return;
      }
      // The daemon and Chrome race at login. Retrying is the normal path, not an error path.
      this.#opts.onStatus('retrying');
      setTimeout(() => this.connect(), this.#backoff);
      this.#backoff = Math.min(BACKOFF_MAX_MS, this.#backoff * 2);
    };

    ws.onerror = () => {
      /* onclose always follows, and does the reconnect */
    };
  }

  send(msg: ClientMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(controlFrame(msg));
  }

  write(streamId: number, data: Uint8Array): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(inputFrame(streamId, data));
  }

  /** Acked from the renderer's write callback, after parsing rather than after queueing. */
  ack(streamId: number, bytes: number): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(ackFrame(streamId, bytes));
  }

  close(): void {
    this.#stopped = true;
    this.#ws?.close();
  }
}
