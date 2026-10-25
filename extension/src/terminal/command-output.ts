import type { IBufferLine, IDisposable, IMarker, Terminal } from '@xterm/xterm';

/**
 * Where each finished command's output is, so it can be copied whole.
 *
 * Asked for as a Copy output button that "should perfectly capture the whole output regardless of
 * formatting and line switches", only once the output is complete, and only in a shell rather
 * than in an agent.
 *
 * **Read from the shell's own marks, in the stream.** The shell integration prints `OSC 133;C`
 * when a command starts and `OSC 133;D` when the next prompt is about to be drawn, and those bytes
 * arrive in the same stream as the output, so a marker taken when each is parsed sits exactly at
 * the first and last row of the output. The daemon's `command-start` and `command-end` messages
 * travel separately from the bytes and could not say which row anything was on.
 *
 * **Complete means the shell came back.** A block exists only once `D` has arrived, which is the
 * shell drawing its next prompt. `tail -f`, a loop, a program waiting for input: none of them has
 * returned, so none of them has a block, whatever the screen looks like.
 *
 * **Not for agents or full-screen programs.** An agent's transcript is its own interface with its
 * own copying, and a program on the alternate screen leaves nothing in the scrollback to copy.
 *
 * **Text, not cells.** Each row is read as text and a row the terminal wrapped is joined to the
 * one before it without a newline, so a long line comes back as the one line the program printed.
 */

/** Agent CLIs by name. Their output is an interface, not a transcript. */
export const AGENT_PROGRAMS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'aider',
  'cursor-agent',
  'gemini',
  'copilot',
]);

/** Runners that start the program named after them, which is then the one that matters. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'exec', 'command', 'nohup', 'time', 'sudo']);

/** Whether a command line starts an agent, looking past `VAR=value` and runners like `npx`. */
export function isAgentCommand(command: string): boolean {
  for (const word of command.trim().split(/\s+/)) {
    if (word === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const name = word.split('/').pop() ?? '';
    if (RUNNERS.has(name)) continue;
    return AGENT_PROGRAMS.has(name.replace(/@.*$/, ''));
  }
  return false;
}

/** The limit people can choose, and the ceiling no choice can pass. */
export const DEFAULT_COPY_LINES = 10_000;
export const MAX_COPY_LINES = 50_000;
export const COPY_LINES_KEY = 'tabterm.copyOutputLines';
export const COPY_LINES_CHOICES: readonly (readonly [string, string])[] = [
  ['1000', '1,000 lines'],
  ['5000', '5,000 lines'],
  ['10000', '10,000 lines (default)'],
  ['50000', '50,000 lines'],
];

/** Bounded, because it decides how much text is put on the clipboard at once. */
export function saneCopyLines(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COPY_LINES;
  return Math.min(MAX_COPY_LINES, Math.max(100, n));
}

export interface OutputBlock {
  /** The first row of output, which is the row after the command line. */
  readonly start: IMarker;
  /** The row the cursor was on when the shell came back. */
  readonly end: IMarker;
  /** Whether that last row has output on it, which it does when the output did not end a line. */
  readonly endsMidLine: boolean;
  readonly command: string;
}

export interface CopiedOutput {
  text: string;
  /** Lines in `text`. */
  lines: number;
  /** Whether lines were left out, by the limit or because the start scrolled out of memory. */
  partial: boolean;
}

/**
 * Rows `first` to `last` inclusive, as the lines a program printed.
 *
 * Exported for the unit test, which drives it with plain objects in place of a buffer.
 */
export function readLines(
  getLine: (row: number) => Pick<IBufferLine, 'isWrapped' | 'translateToString'> | undefined,
  first: number,
  last: number,
): string[] {
  const lines: string[] = [];
  for (let row = first; row <= last; row++) {
    const line = getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  // A wrapped line's continuation keeps its trailing spaces in the middle, and only the end is
  // trimmed, which is what a terminal's own copy does.
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  return lines.map((l) => l.replace(/\s+$/, ''));
}

/** The last `limit` lines, and whether that left anything out. */
export function limitLines(lines: readonly string[], limit: number): CopiedOutput {
  const kept = lines.length > limit ? lines.slice(lines.length - limit) : lines;
  return { text: kept.join('\n'), lines: kept.length, partial: kept.length < lines.length };
}

/** Most recent commands kept, since a marker costs something per line it watches. */
const MAX_BLOCKS = 200;

export class CommandBlocks {
  readonly #term: Terminal;
  readonly #blocks: OutputBlock[] = [];
  readonly #subs: IDisposable[] = [];
  /** The command running now, between its `C` and its `D`. */
  #open: { start: IMarker; command: string; fullScreen: boolean } | null = null;
  /** The command line, which `OSC 1338` brings right after `C`. */
  #pendingCommand = '';

  constructor(term: Terminal) {
    this.#term = term;
    this.#subs.push(
      term.parser.registerOscHandler(133, (data) => {
        this.#mark(data);
        // Not consumed: anything else listening for the same marks still hears them.
        return false;
      }),
      term.parser.registerOscHandler(1338, (data) => {
        try {
          const command = decodeURIComponent(data);
          if (this.#open && this.#open.command === '') this.#open.command = command;
          else this.#pendingCommand = command;
        } catch {
          /* a command line that does not decode is simply not known */
        }
        return false;
      }),
      term.buffer.onBufferChange((buffer) => {
        if (buffer.type === 'alternate' && this.#open) this.#open.fullScreen = true;
      }),
    );
  }

  /** How many finished blocks there are, for a check to read. */
  get count(): number {
    return this.#blocks.length;
  }

  #mark(data: string): void {
    const kind = data[0];
    if (kind === 'C') {
      this.#open?.start.dispose();
      const start = this.#term.registerMarker(0);
      this.#open = start
        ? {
            start,
            command: this.#pendingCommand,
            fullScreen: this.#term.buffer.active.type === 'alternate',
          }
        : null;
      this.#pendingCommand = '';
      return;
    }
    if (kind !== 'D') return;
    const open = this.#open;
    this.#open = null;
    if (!open) return;
    const end = this.#term.registerMarker(0);
    if (!end || open.start.isDisposed || open.fullScreen || isAgentCommand(open.command)) {
      open.start.dispose();
      end?.dispose();
      return;
    }
    this.#blocks.push({
      start: open.start,
      end,
      endsMidLine: this.#term.buffer.active.cursorX > 0,
      command: open.command,
    });
    while (this.#blocks.length > MAX_BLOCKS) {
      const old = this.#blocks.shift();
      old?.start.dispose();
      old?.end.dispose();
    }
  }

  /** The last row a block's output is on. */
  #lastRow(block: OutputBlock): number {
    return block.endsMidLine ? block.end.line : block.end.line - 1;
  }

  /**
   * The finished block a buffer row belongs to, counting its command line, or none.
   *
   * A block whose output is empty has nothing to copy, and one whose end marker scrolled out of
   * memory has nothing left at all.
   */
  blockAt(row: number): OutputBlock | undefined {
    if (this.#term.buffer.active.type === 'alternate') return undefined;
    for (let i = this.#blocks.length - 1; i >= 0; i--) {
      const block = this.#blocks[i];
      if (!block || block.end.isDisposed) continue;
      const first = block.start.isDisposed ? 0 : block.start.line - 1;
      const last = this.#lastRow(block);
      if (last < first + 1) continue;
      if (row >= first && row <= last) return block;
    }
    return undefined;
  }

  /** The row to place a button against: the command line, or the top of the output if gone. */
  headRow(block: OutputBlock): number {
    return block.start.isDisposed ? 0 : block.start.line - 1;
  }

  lastRow(block: OutputBlock): number {
    return this.#lastRow(block);
  }

  /** The block's output as text, at most `limit` lines of it. */
  copy(block: OutputBlock, limit: number): CopiedOutput {
    const buffer = this.#term.buffer.active;
    const first = block.start.isDisposed ? 0 : block.start.line;
    const lines = readLines((row) => buffer.getLine(row), first, this.#lastRow(block));
    const out = limitLines(lines, limit);
    // The start gone from memory means the beginning of the output is gone with it.
    if (block.start.isDisposed) out.partial = true;
    return out;
  }

  /** Copied output of every block, for a check to read. */
  all(limit: number): CopiedOutput[] {
    return this.#blocks.filter((b) => !b.end.isDisposed).map((b) => this.copy(b, limit));
  }

  /** A clear empties the buffer, and every block with it. */
  clear(): void {
    for (const b of this.#blocks.splice(0)) {
      b.start.dispose();
      b.end.dispose();
    }
  }

  dispose(): void {
    this.clear();
    this.#open?.start.dispose();
    this.#open = null;
    for (const s of this.#subs) s.dispose();
  }
}
