import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { GUESS_EXPIRES_MS, Predictor } from './predict.js';

/**
 * Instant typing, checked against a real terminal emulator: what the page would show ahead of the
 * Mac's echo, and that it shows nothing it cannot back up. The Mac's side is played by writing
 * into the terminal exactly what a shell, a password prompt, an editor or an agent sends back.
 */
function setup(prompt = '$ ') {
  const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  let now = 1000;
  const p = new Predictor(
    term,
    () => {},
    () => now,
  );
  const draw = async (data: string): Promise<void> => {
    await new Promise<void>((r) => term.write(data, r));
    p.check();
  };
  const shown = (): string => p.shown.map((g) => g.ch).join('');
  return {
    term,
    p,
    draw,
    shown,
    later: (ms: number) => (now += ms),
    ready: () => draw(prompt),
  };
}

describe('instant typing', () => {
  it('shows nothing until the Mac has echoed a key where it was guessed, then shows keys at once', async () => {
    const t = setup();
    await t.ready();
    t.p.key('l');
    expect(t.shown()).toBe('');
    await t.draw('l');
    t.p.key('s');
    expect(t.shown()).toBe('s');
    expect(t.p.shown[0]).toMatchObject({ x: 3, y: 0 });
    expect(t.p.cursor).toEqual({ x: 4, y: 0 });
    t.p.key(' ');
    t.p.key('-');
    expect(t.shown()).toBe('s -');
    // The echoes catch up, and each guess gives way to the real thing.
    await t.draw('s -');
    expect(t.shown()).toBe('');
    t.p.key('l');
    expect(t.shown()).toBe('l');
  });

  it('starts over after Return, so a password prompt never shows what is typed', async () => {
    const t = setup();
    await t.ready();
    t.p.key('s');
    await t.draw('s');
    t.p.key('u');
    expect(t.shown()).toBe('u');
    t.p.key('\r');
    expect(t.shown()).toBe('');
    await t.draw('u\r\nPassword: ');
    for (const ch of 'secret') t.p.key(ch);
    expect(t.shown()).toBe('');
    // Nothing comes back, and after a while the guesses are dropped, never having been shown.
    t.later(GUESS_EXPIRES_MS + 1);
    t.p.check();
    expect(t.shown()).toBe('');
    t.p.key('x');
    expect(t.shown()).toBe('');
  });

  it('stops showing guesses the moment one comes back as something else', async () => {
    const t = setup();
    await t.ready();
    t.p.key('a');
    await t.draw('a');
    t.p.key('b');
    t.p.key('c');
    expect(t.shown()).toBe('bc');
    // The program drew something else where b was guessed, as a key with a meaning would.
    await t.draw('X');
    expect(t.shown()).toBe('');
    t.p.key('d');
    expect(t.shown()).toBe('');
  });

  it('guesses nothing in the middle of a line, which typing would push along', async () => {
    const t = setup();
    await t.ready();
    t.p.key('a');
    await t.draw('abc');
    // An arrow key, then typing: the rest of the line would move, so the echo is waited for.
    t.p.key('\x1b[D');
    await t.draw('\x1b[D');
    t.p.key('x');
    await t.draw('xc\x1b[D');
    t.p.key('y');
    expect(t.shown()).toBe('');
  });

  it('takes back what backspace removes, and never guesses past where typing began', async () => {
    const t = setup();
    await t.ready();
    t.p.key('a');
    await t.draw('a');
    t.p.key('b');
    t.p.key('\x7f');
    expect(t.shown()).toBe('');
    t.p.key('c');
    expect(t.shown()).toBe('c');
    await t.draw('c');
    // Erasing what was echoed shows the cell empty at once, and the shell's own erase confirms it.
    t.p.key('\x7f');
    expect(t.p.shown).toMatchObject([{ x: 3, erase: true }]);
    await t.draw('\b \b');
    expect(t.p.shown).toEqual([]);
    t.p.key('\x7f');
    await t.draw('\b \b');
    // The prompt is the shell's: a backspace there is not guessed at.
    t.p.key('\x7f');
    expect(t.shown()).toBe('');
    t.p.key('z');
    expect(t.shown()).toBe('');
  });

  it('works in an agent that redraws its input with the cursor hidden, and puts it back after', async () => {
    const t = setup('');
    // An agent's input box, drawn the way Claude Code draws it: cursor hidden while it moves
    // about, and shown again where typing goes.
    await t.draw('\x1b[?25l\x1b[5;1H> \x1b[?25h');
    t.p.key('h');
    await t.draw('\x1b[?25l\x1b[H\r\x1b[2C\x1b[4Bh');
    // Midway: the cursor is wherever the redraw left it, so nothing is judged yet.
    t.p.key('e');
    await t.draw('\x1b[10;1H\x1b[5;4H\x1b[?25h');
    expect(t.shown()).toBe('e');
    expect(t.p.shown[0]).toMatchObject({ x: 3, y: 4 });
    await t.draw('\x1b[?25l\x1b[H\r\x1b[3C\x1b[4Be\x1b[10;1H\x1b[5;5H\x1b[?25h');
    expect(t.shown()).toBe('');
  });

  it('types over a faint suggestion, as a shell draws one after the cursor', async () => {
    const t = setup();
    await t.ready();
    t.p.key('g');
    // The shell echoes g and suggests the rest of a command from history, in grey.
    await t.draw('g\x1b[90mit status\x1b[0m\x1b[9D');
    t.p.key('i');
    expect(t.shown()).toBe('i');
  });

  it('starts over when a full screen program opens or closes', async () => {
    const t = setup();
    await t.ready();
    t.p.key('v');
    await t.draw('v');
    t.p.key('i');
    expect(t.shown()).toBe('i');
    await t.draw('\x1b[?1049h');
    expect(t.shown()).toBe('');
  });

  it('leaves wide characters and anything with a meaning to the echo', async () => {
    const t = setup();
    await t.ready();
    t.p.key('a');
    await t.draw('a');
    t.p.key('漢');
    expect(t.shown()).toBe('');
    t.p.key('b');
    expect(t.shown()).toBe('');
  });
});
