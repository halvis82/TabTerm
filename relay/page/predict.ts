/**
 * Instant typing: a key shows the moment it is pressed, before the Mac's echo has come back.
 *
 * Over the internet the echo of a key takes a tenth of a second or more, and typing feels like
 * wading. So the page guesses what the echo will be, the way mosh does, shows the guess at once,
 * and checks every guess against what the Mac then actually draws.
 *
 * **It never shows what it cannot back up.** After anything that may change what typing does,
 * such as Return, an arrow key, Ctrl C or a guess that came out wrong, guesses are made but kept
 * hidden until one of them is confirmed by the real echo. So at a password prompt, which echoes
 * nothing, nothing is ever shown, and in a program where keys do something other than type, the
 * first key proves it and nothing is shown either. Only once the Mac has echoed a key exactly where
 * the guess put it are the keys after it shown ahead of the echo.
 *
 * **It only guesses the plain case**: a printable character typed at the cursor, at the end of
 * what is on that line, and backspace over what was typed since. Typing into the middle of a line
 * would push the rest of it along, which a guess drawn over one cell cannot show, so that waits for
 * the echo as before. A guess that is wrong is gone at the next thing the Mac draws.
 *
 * Nothing here touches the terminal itself. Guesses are drawn over it by the page, and the
 * terminal only ever shows what the Mac sent.
 */

/** As much of a cell as is read here, the same in xterm and its headless twin. */
interface Cell {
  getChars(): string;
  isDim(): number;
  getFgColorMode(): number;
  getFgColor(): number;
}

interface Buffer {
  readonly type: 'normal' | 'alternate';
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  getLine(y: number): { getCell(x: number): Cell | undefined } | undefined;
}

/** The terminal, as much of it as guessing needs. */
export interface Screen {
  readonly cols: number;
  readonly buffer: { readonly active: Buffer };
  readonly modes: { readonly insertMode: boolean };
  readonly parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): { dispose(): void };
  };
}

export interface Guess {
  /** Column, and line in the whole buffer, so scrolling does not move it. */
  x: number;
  y: number;
  ch: string;
  /** A backspace: the cell is guessed to become empty. */
  erase: boolean;
  epoch: number;
  at: number;
}

/** A guess not echoed in this long was wrong, as at a prompt that hides what is typed. */
export const GUESS_EXPIRES_MS = 2000;

/** Characters one cell wide, whose echo is the character itself. */
function plain(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return false;
  // Wide characters, and the combining and joining ones, are left to the echo.
  return c < 0x0300 || (c >= 0x0370 && c < 0x1100);
}

export class Predictor {
  readonly #screen: Screen;
  #guesses: Guess[] = [];
  /** Bumped by anything that may change what typing does. Guesses carry the one they were made in. */
  #epoch = 0;
  /** The newest epoch with a guess the Mac's echo confirmed. Its guesses are shown. */
  #trusted = -1;
  /** Where typing in this epoch began, which backspace never guesses past. */
  #from: { x: number; y: number } | null = null;
  #cursorHidden = false;
  #synchronized = false;
  #alternate = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #changed: () => void;
  readonly #now: () => number;

  constructor(screen: Screen, changed: () => void = () => {}, now: () => number = Date.now) {
    this.#screen = screen;
    this.#changed = changed;
    this.#now = now;
    /*
     * Whether the cursor is hidden, and whether the program is midway through drawing. Agents hide
     * the cursor, move it about to redraw, and put it back where typing goes; only then does its
     * position say anything, so guesses wait for that.
     */
    for (const final of ['h', 'l']) {
      screen.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        for (const p of params) {
          if (p === 25) this.#cursorHidden = final === 'l';
          if (p === 2026) this.#synchronized = final === 'h';
        }
        return false;
      });
    }
  }

  /** What to draw over the terminal now: the guesses of an epoch the echo has vouched for. */
  get shown(): readonly Guess[] {
    return this.#epoch === this.#trusted ? this.#guesses : [];
  }

  /** Where the cursor will be once the shown guesses are echoed, when any are shown. */
  get cursor(): { x: number; y: number } | null {
    const last = this.shown.at(-1);
    return last ? { x: last.erase ? last.x : last.x + 1, y: last.y } : null;
  }

  /** Forget every guess, and show none again until one is confirmed. */
  reset(): void {
    const had = this.#guesses.length > 0;
    this.#guesses = [];
    this.#epoch++;
    this.#from = null;
    clearTimeout(this.#timer);
    if (had) this.#changed();
  }

  /** A key about to be sent to the Mac. */
  key(data: string): void {
    if (data === '\x7f' || data === '\b') this.#backspace();
    else if ([...data].every(plain)) for (const ch of data) this.#type(ch);
    else this.reset();
    this.#changed();
  }

  #next(): { x: number; y: number } {
    const last = this.#guesses.at(-1);
    if (last) return { x: last.erase ? last.x : last.x + 1, y: last.y };
    const b = this.#screen.buffer.active;
    return { x: b.cursorX, y: b.baseY + b.cursorY };
  }

  /** Whether the cell holds nothing typed: empty, or a faint hint such as a suggestion. */
  #empty(x: number, y: number): boolean {
    const cell = this.#screen.buffer.active.getLine(y)?.getCell(x);
    if (!cell) return true;
    const ch = cell.getChars();
    if (ch === '' || ch === ' ') return true;
    // Dim, or the "bright black" a shell's suggestion is drawn in.
    return cell.isDim() !== 0 || (cell.getFgColorMode() !== 0 && cell.getFgColor() === 8);
  }

  #type(ch: string): void {
    // Midway through a redraw the cursor says nothing, unless this follows a guess already made.
    const midway = this.#cursorHidden || this.#synchronized;
    if ((midway && this.#guesses.length === 0) || this.#screen.modes.insertMode) {
      this.reset();
      return;
    }
    const at = this.#next();
    // At the edge the line wraps, which is the Mac's to draw.
    if (at.x >= this.#screen.cols - 1) {
      this.reset();
      return;
    }
    // Only at the end of what is on the line: anything typed before it would be pushed along.
    for (let x = at.x; x < this.#screen.cols; x++) {
      if (!this.#empty(x, at.y)) {
        this.reset();
        return;
      }
    }
    this.#from ??= at;
    this.#guesses.push({ ...at, ch, erase: false, epoch: this.#epoch, at: this.#now() });
    this.#expireLater();
  }

  #backspace(): void {
    const at = this.#next();
    const from = this.#from;
    // Never over what was there before typing began, such as the prompt.
    if (!from || at.y !== from.y || at.x - 1 < from.x) {
      this.reset();
      return;
    }
    const last = this.#guesses.at(-1);
    if (last && !last.erase && last.x === at.x - 1) {
      // Typed and not echoed yet: the guess just goes.
      this.#guesses.pop();
      return;
    }
    this.#guesses.push({
      x: at.x - 1,
      y: at.y,
      ch: ' ',
      erase: true,
      epoch: this.#epoch,
      at: this.#now(),
    });
    this.#expireLater();
  }

  #expireLater(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.check(), GUESS_EXPIRES_MS + 50);
  }

  /** The Mac drew something: every guess is checked against it. */
  check(): void {
    const b = this.#screen.buffer.active;
    const alternate = b.type === 'alternate';
    if (alternate !== this.#alternate) {
      this.#alternate = alternate;
      this.reset();
      return;
    }
    if (this.#guesses.length === 0) return;
    const now = this.#now();
    // Midway through a redraw the cursor is anywhere: checked once the program has finished.
    if (this.#cursorHidden || this.#synchronized) {
      if (now - (this.#guesses[0]?.at ?? now) > GUESS_EXPIRES_MS) this.reset();
      return;
    }
    const cursor = { x: b.cursorX, y: b.baseY + b.cursorY };
    const before = this.#guesses.length;
    while (this.#guesses.length > 0) {
      const g = this.#guesses[0];
      if (!g) break;
      if (g.y !== cursor.y) {
        // The cursor left the line, by output or by the program: these guesses are stale.
        this.reset();
        return;
      }
      const real = b.getLine(g.y)?.getCell(g.x)?.getChars() || ' ';
      const passed = g.erase ? cursor.x <= g.x : cursor.x > g.x;
      if (passed && real === g.ch) {
        this.#trusted = g.epoch;
        this.#guesses.shift();
        continue;
      }
      if (passed || now - g.at > GUESS_EXPIRES_MS) {
        // Echoed as something else, or not at all: typing does not do what was guessed here.
        this.reset();
        return;
      }
      break;
    }
    if (this.#guesses.length !== before) this.#changed();
    if (this.#guesses.length === 0) clearTimeout(this.#timer);
  }

  dispose(): void {
    clearTimeout(this.#timer);
  }
}
