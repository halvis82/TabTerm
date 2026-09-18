import { describe, expect, it } from 'vitest';
import { needlesFor, rowOfTyped, TypedLine } from './input-anchor.js';

/**
 * The screen an agent leaves behind after a prompt is submitted, in the shape he photographed.
 *
 * The cursor was on row 12, inside the input box, when Return was pressed. The prompt itself is on
 * row 6, in the transcript, drawn there by the redraw that followed. Six rows is the whole bug.
 */
const afterAnAgentRedrew = {
  from: 0,
  lines: [
    'tabterm on main',
    '',
    '  Read docs/07-terminal-fidelity.md',
    '  Read extension/src/terminal/markers.ts',
    '',
    '',
    '> the prompt indicators in the scroll bar do not line up',
    '',
    '  I will move the mark to where the line landed.',
    '',
    'â•­â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•®',
    'â”‚ >                                       â”‚',
    'â•°â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•¯',
  ],
};

describe('finding the line that was typed', () => {
  it('moves the mark from the input box to the line the prompt landed on', () => {
    const row = rowOfTyped(
      afterAnAgentRedrew,
      'the prompt indicators in the scroll bar do not line up',
      12,
    );
    expect(row).toBe(6);
  });

  /*
   * A shell needs nothing done. The cursor was on the command line and the command is on it, so
   * the answer is the row the mark is already on and the mark does not move.
   */
  it('and leaves a shell command exactly where the cursor was', () => {
    const shell = {
      from: 100,
      lines: ['~/code $ npm run check', 'ok', '~/code $ npm run check', ''],
    };
    expect(rowOfTyped(shell, 'npm run check', 102)).toBe(102);
  });

  it('takes the copy nearest the cursor when the same thing was typed twice', () => {
    const twice = { from: 0, lines: ['> run the tests', 'ok', '> run the tests', '', ''] };
    expect(rowOfTyped(twice, 'run the tests', 4)).toBe(2);
    expect(rowOfTyped(twice, 'run the tests', 0)).toBe(0);
  });

  /*
   * A program is free to draw the line differently from the way it was typed: inside a box, behind
   * a marker, wrapped, indented. What it is not free to do is say something else.
   */
  it('finds it through a box, an indent and a prefix', () => {
    const drawn = { from: 0, lines: ['', '  | > please  read   the  briefing |', ''] };
    expect(rowOfTyped(drawn, 'please read the briefing', 2)).toBe(1);
  });

  it('and through a wrap, on the shorter second try', () => {
    const wrapped = {
      from: 0,
      lines: ['> summarize what changed in the daemon', 'since friday afternoon', ''],
    };
    expect(rowOfTyped(wrapped, 'summarize what changed in the daemon since friday', 2)).toBe(0);
  });

  it('says nothing when the line is not there', () => {
    expect(rowOfTyped(afterAnAgentRedrew, 'something nobody typed here', 12)).toBe(null);
  });

  /*
   * And nothing at all for a line too ordinary to identify. `y` appears on half the rows of an
   * agent's screen, and a mark that jumped to one of them would be pointing at a stranger.
   */
  it('and refuses to look for a line too short to be anybody in particular', () => {
    expect(needlesFor('y')).toEqual([]);
    expect(needlesFor('ok')).toEqual([]);
    expect(rowOfTyped({ from: 0, lines: ['yes', 'y', 'y'] }, 'y', 2)).toBe(null);
  });

  it('looks for the head of a long line, and then for less of it', () => {
    const long = 'please go and read every one of the documents under the docs directory';
    expect(needlesFor(long)).toEqual([
      'please go and read every one of the docu',
      'please go and re',
    ]);
  });
});

describe('the line as it is typed', () => {
  const feed = (chunks: string[]): (string | null)[] => {
    const line = new TypedLine();
    return chunks.map((c) => line.consume(c));
  };

  it('gives the line back when Return is pressed', () => {
    expect(feed(['h', 'e', 'l', 'l', 'o', '\r'])).toEqual([null, null, null, null, null, 'hello']);
  });

  it('and starts empty again for the next one', () => {
    const line = new TypedLine();
    for (const c of 'one\r') line.consume(c);
    for (const c of 'two') line.consume(c);
    expect(line.consume('\r')).toBe('two');
  });

  it('takes a backspace off the end', () => {
    const line = new TypedLine();
    for (const c of 'helo') line.consume(c);
    line.consume('');
    for (const c of 'lo') line.consume(c);
    expect(line.consume('\r')).toBe('hello');
  });

  it('counts a paste as text on the line', () => {
    const line = new TypedLine();
    line.consume('read ');
    line.consume('/Users/somebody/a/very/long/path.ts');
    expect(line.consume('\r')).toBe('read /Users/somebody/a/very/long/path.ts');
  });

  it('and a pasted line that ends in a Return submits what came with it', () => {
    expect(new TypedLine().consume('npm run check\r')).toBe('npm run check');
  });

  /*
   * Everything below here is the give-up direction. Being wrong here means an empty line, which
   * means the mark stays at the cursor: exactly where it used to be, and nowhere surprising.
   */
  it('gives up on a control character, which may have edited the line', () => {
    const line = new TypedLine();
    for (const c of 'half a command') line.consume(c);
    line.consume('');
    for (const c of 'the rest') line.consume(c);
    expect(line.consume('\r')).toBe('the rest');
  });

  it('and on a key sequence', () => {
    const line = new TypedLine();
    for (const c of 'typed') line.consume(c);
    line.consume('[A');
    expect(line.consume('\r')).toBe('');
  });

  /*
   * Shift and Return is the exception among key sequences: it is a new line inside the program's
   * own box rather than something this cannot model, and the line it is part of goes on.
   */
  it('keeps going through Shift and Return, which is not a submit', () => {
    const line = new TypedLine();
    for (const c of 'first line') line.consume(c);
    expect(line.consume('\r')).toBe(null);
    for (const c of 'second line') line.consume(c);
    expect(line.consume('\r')).toBe('first line second line');
  });

  it('unwraps a bracketed paste rather than giving up on one', () => {
    const line = new TypedLine();
    line.consume('[200~read docs/07-terminal-fidelity.md\nand say what changed[201~');
    expect(line.consume('\r')).toBe('read docs/07-terminal-fidelity.md and say what changed');
  });
});
