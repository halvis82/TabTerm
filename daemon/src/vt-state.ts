import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { installCurrentWidths } from '@tabterm/shared';

// Both ship CommonJS. Node ESM cannot destructure their named exports.
const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;
const { Unicode11Addon } = unicode11;

/**
 * The parts of the emulator that are not on its public interface.
 *
 * Declared rather than cast at the point of use, so what is being reached for is written down.
 * Every field is optional: this is somebody else's private shape and it is allowed to change.
 */
interface Internals {
  coreService?: { isCursorHidden?: boolean };
  coreMouseService?: { activeEncoding?: string; activeProtocol?: string };
}

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
    // Before anything is written, and with the same table the page uses. A screen measured under
    // one set of widths and redrawn under another is a screen that does not match itself.
    installCurrentWidths(this.#term, new Unicode11Addon());
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
   * How much scrollback this terminal is actually keeping.
   *
   * Readable because the setting that governs it could not be checked from outside. A budget that
   * reached the sessions that already existed and not the ones opened afterwards is a defect that
   * nothing could assert on, so what was written instead were tests that read the server's source
   * and looked for the right lines. Those pass whenever the text is right, which is not the same
   * claim.
   */
  get scrollback(): number {
    return this.#term.options.scrollback ?? 0;
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

  /**
   * Wait for everything written so far to have been parsed.
   *
   * Writing is queued and parsed a task later, so anything that reads this terminal's state
   * immediately after writing to it reads the state from before the write. Nothing in the daemon
   * needs this, because nothing there writes and reads in the same breath. A check does.
   */
  flush(): Promise<void> {
    return new Promise((resolve) => this.#term.write('', () => resolve()));
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
    /*
     * An empty screen stays empty, suffix and all.
     *
     * "There is nothing on this screen" is a fact other code acts on: the restore record refuses
     * to overwrite a screen it captured while a pane was alive with an empty one taken after the
     * process had gone. Describing the modes of a screen with nothing on it turned that empty
     * string into six bytes, the guard stopped recognising it, and a dead pane erased the work it
     * was supposed to be keeping. Caught by a check that restored a tab and found a bare prompt.
     */
    const drawn = this.#serializer.serialize({ scrollback });
    return {
      screen: drawn === '' ? '' : drawn + this.#modesTheSerializerMisses(),
      seq: this.#seq,
      cols: this.#cols,
      rows: this.#rows,
      altScreen: this.#term.buffer.active.type === 'alternate',
    };
  }

  /**
   * The two pieces of terminal state the serialize addon leaves out.
   *
   * It restores the alternate screen, bracketed paste, the keypad and cursor key modes, wrapping,
   * focus reporting and whether the mouse is being tracked. It says nothing about either of these,
   * and both are things a program set deliberately and is still relying on.
   *
   * **Whether the cursor is hidden.** An agent's interface hides the real cursor and draws its own.
   * Replay the screen without that and the real cursor comes back: a block sitting wherever the
   * last frame left it, which for that interface is the bottom left, jumping about as the frame is
   * redrawn on each keystroke. Reported as a second typing indicator in every restored tab, which
   * is exactly what it is.
   *
   * **Which format mouse reports are in.** Tracking is restored and the encoding is not, so a
   * program that asked for the modern format is told about clicks in the 1980s one. That format
   * cannot express a column past 95, which is most of a full width terminal, and reports a release
   * as an anonymous button. The program sees clicks in the wrong place, or none.
   *
   * Read off the emulator rather than tracked here, so a reset sequence or anything else that
   * changes them is accounted for without this having to know about it. The path is private, so it
   * is checked rather than trusted: an xterm that stops exposing it leaves the snapshot exactly as
   * it was before this existed, which is a worse screen and not a broken one.
   */
  #modesTheSerializerMisses(): string {
    const core = (this.#term as unknown as { _core?: Internals })._core;
    let out = '';
    const hidden = core?.coreService?.isCursorHidden;
    if (typeof hidden === 'boolean') out += hidden ? '\u001b[?25l' : '\u001b[?25h';
    const encoding = core?.coreMouseService?.activeEncoding;
    const protocol = core?.coreMouseService?.activeProtocol;
    // Only alongside tracking that is actually on: an encoding on its own says nothing and would
    // be a mode set on a terminal whose program never asked for one.
    if (protocol !== undefined && protocol !== 'NONE') {
      if (encoding === 'SGR') out += '\u001b[?1006h';
      else if (encoding === 'UTF8') out += '\u001b[?1005h';
      else if (encoding === 'URXVT') out += '\u001b[?1015h';
    }
    return out;
  }

  dispose(): void {
    this.#term.dispose();
  }
}
