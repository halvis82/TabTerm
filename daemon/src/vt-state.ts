import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

// Both ship CommonJS. Node ESM cannot destructure their named exports.
const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

/**
 * Server-side terminal state, one per session.
 *
 * This is what makes reattach exact. Replaying a raw byte log does not work: the moment an
 * application uses the alternate screen, the log holds a sequence of screens rather than the
 * current one. Verified against seven recorded PTY fixtures, three captured inside the
 * alternate screen, all round-tripping cell for cell. See docs/07-terminal-fidelity.md.
 *
 * Measured cost: 3.6 MB per session at 10,000 scrollback lines, 32 ms to serialize.
 */
export class VtState {
  readonly #term: InstanceType<typeof Terminal>;
  readonly #serializer: InstanceType<typeof SerializeAddon>;
  #seq = 0;
  #cols: number;
  #rows: number;

  constructor(cols: number, rows: number, scrollback: number) {
    this.#cols = cols;
    this.#rows = rows;
    this.#term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.#serializer = new SerializeAddon();
    this.#term.loadAddon(this.#serializer);
  }

  /**
   * Change how much scrollback is kept, on a terminal that is already running.
   *
   * Lowering it drops the oldest lines immediately, which is the point: switching to a lower
   * memory mode has to actually release memory rather than only apply to sessions started
   * afterwards.
   */
  setScrollback(lines: number): void {
    this.#term.options.scrollback = Math.max(0, Math.floor(lines));
  }

  /**
   * Throw away everything above the visible screen.
   *
   * What "clear" has to mean if it is to mean anything. Clearing used to wipe only the xterm
   * buffer inside one tab, so the output was still here, still in the pane snapshot, and came
   * straight back on the next reload. Somebody who clears because a token was echoed had
   * cleared nothing. See docs/07-terminal-fidelity.md.
   */
  clearScrollback(): void {
    // xterm's own `clear` keeps the current line and discards the rest, which is exactly the
    // behavior a person expects from the key.
    this.#term.clear();
  }

  get seq(): number {
    return this.#seq;
  }
  get cols(): number {
    return this.#cols;
  }
  get rows(): number {
    return this.#rows;
  }

  /**
   * The daemon ALWAYS feeds, whether or not a frontend is attached. Pausing reads would fill
   * the PTY buffer and block the child on write(), which presents as a hung terminal.
   */
  write(data: string | Uint8Array): void {
    this.#seq += typeof data === 'string' ? data.length : data.byteLength;
    this.#term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.#cols && rows === this.#rows) return;
    this.#cols = cols;
    this.#rows = rows;
    this.#term.resize(cols, rows);
  }

  /**
   * Serialize the whole screen, including the preserved primary buffer when the alternate
   * screen is active. Verified: reattaching mid-edit and then quitting the editor shows the
   * shell history intact.
   */
  snapshot(scrollback: number): {
    screen: string;
    seq: number;
    cols: number;
    rows: number;
    altScreen: boolean;
  } {
    return {
      screen: this.#serializer.serialize({ scrollback }),
      seq: this.#seq,
      cols: this.#cols,
      rows: this.#rows,
      altScreen: this.#term.buffer.active.type === 'alternate',
    };
  }

  dispose(): void {
    this.#term.dispose();
  }
}
