import { describe, expect, it } from 'vitest';
import { InputLine, rowsNeeded } from './input-line.js';

const BACKSPACE = '';
const INTERRUPT = '';
const KILL_LINE = '';
const ARROW_UP = '[A';

const feed = (line: InputLine, text: string) => {
  for (const ch of text) line.consume(ch);
  return line;
};

/**
 * The box under the start screen grows to fit the line being typed, and this is how it knows how
 * long that line is.
 *
 * It cannot read it off the screen: in a three row terminal zsh truncates a long line and draws
 * `>....` rather than wrapping it, so the line is genuinely not there to be counted.
 */
describe('how long the line being typed is', () => {
  it('counts what was typed, spaces included', () => {
    // The buffer that watches for abbreviations forgets the line on every space, which is right
    // for an abbreviation and useless here: it made the box stop growing at the first word.
    expect(feed(new InputLine(), 'git commit -m hello').length).toBe(19);
  });

  it('takes backspace off, and never goes below nothing', () => {
    const line = feed(new InputLine(), 'abc');
    line.consume(BACKSPACE);
    expect(line.length).toBe(2);
    for (let i = 0; i < 10; i++) line.consume(BACKSPACE);
    expect(line.length).toBe(0);
  });

  it('ends the line on Return, wherever it appears in the chunk', () => {
    const line = feed(new InputLine(), 'echo hi');
    line.consume('\r');
    expect(line.length).toBe(0);
    const pasted = new InputLine();
    pasted.consume('one\rtwo');
    expect(pasted.length).toBe(0);
  });

  it('counts a paste, because pasted text is on the line like any other', () => {
    const line = new InputLine();
    line.consume('a'.repeat(300));
    expect(line.length).toBe(300);
  });

  it('gives up on a key sequence rather than guessing', () => {
    // An arrow key or a completion can change the line in ways this does not model. Being wrong
    // small keeps the box small, which is the harmless direction.
    const line = feed(new InputLine(), 'ls -la');
    line.consume(ARROW_UP);
    expect(line.length).toBe(0);
  });

  it('gives up on an interrupt or a kill, both of which really do empty the line', () => {
    const interrupted = feed(new InputLine(), 'rm -rf');
    interrupted.consume(INTERRUPT);
    expect(interrupted.length).toBe(0);

    const killed = feed(new InputLine(), 'rm -rf');
    killed.consume(KILL_LINE);
    expect(killed.length).toBe(0);
  });

  it('is not fooled by a very long line, which is the case it exists for', () => {
    // The abbreviation buffer keeps only the last 512 characters, which is why the box stopped
    // growing at about six rows however much was typed.
    const line = new InputLine();
    for (let i = 0; i < 1200; i++) line.consume('f');
    expect(line.length).toBe(1200);
  });
});

describe('how many rows that needs', () => {
  it('allows for the prompt in front of it', () => {
    expect(rowsNeeded(30, 0, 100)).toBe(1);
    expect(rowsNeeded(30, 69, 100)).toBe(1);
    expect(rowsNeeded(30, 70, 100)).toBe(2);
  });

  it('leaves the cursor somewhere to sit', () => {
    // A line that exactly fills the width puts the cursor on the next row, and a box that did
    // not allow for it hid the cursor.
    expect(rowsNeeded(0, 100, 100)).toBe(2);
  });

  it('survives a terminal of no width', () => {
    expect(rowsNeeded(0, 10, 0)).toBeGreaterThan(0);
  });
});
