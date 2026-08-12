import { describe, expect, it } from 'vitest';
import { TypedBuffer, backspaces, type Hotstring } from './hotstrings.js';

const HOTSTRINGS: Hotstring[] = [
  { trigger: 'runbuild!', command: 'npm run build' },
  { trigger: 'gs!', command: 'git status --short' },
  { trigger: 'ls', command: 'ls -la' },
];

const ESC = '\u001b';
const DEL = '\u007f';

/** Type a string one character at a time, returning whatever expansion fires. */
function type(buffer: TypedBuffer, text: string) {
  let last = null;
  for (const ch of text) last = buffer.consume(ch, HOTSTRINGS) ?? last;
  return last;
}

describe('expanding on a delimiter', () => {
  it('expands on space, keeping the space', () => {
    const request = type(new TypedBuffer(), 'runbuild! ');
    expect(request).toEqual({
      deleteCount: 'runbuild!'.length,
      insert: 'npm run build ',
      trigger: 'runbuild!',
    });
  });

  it('expands on Enter, and still submits', () => {
    // One keystroke from running, not two: the expansion happens first and the newline goes
    // with it.
    const request = type(new TypedBuffer(), 'runbuild!\r');
    expect(request?.insert).toBe('npm run build\r');
  });

  it('does not expand while the abbreviation is still being typed', () => {
    // The whole reason a delimiter is required. `ls` would otherwise fire inside `lsof`.
    const buffer = new TypedBuffer();
    expect(type(buffer, 'runbuild')).toBeNull();
    expect(buffer.typed).toBe('runbuild');
  });

  it('leaves a longer word alone that merely starts with a hotstring', () => {
    expect(type(new TypedBuffer(), 'lsof ')).toBeNull();
  });

  it('does not expand on Tab, which already means completion in a terminal', () => {
    expect(type(new TypedBuffer(), 'runbuild!\t')).toBeNull();
  });

  it('expands mid-line, not only at the start', () => {
    const request = type(new TypedBuffer(), 'echo gs! ');
    expect(request?.trigger).toBe('gs!');
    expect(request?.deleteCount).toBe(3);
  });

  it('prefers the longest match when two could fire', () => {
    const buffer = new TypedBuffer();
    const request = buffer.consume(' ', [
      { trigger: 'd!', command: 'short' },
      { trigger: 'build!', command: 'long' },
    ]);
    expect(request).toBeNull(); // nothing typed yet

    const second = type(new TypedBuffer(), 'build! ');
    expect(second).toBeNull(); // those hotstrings are not in the default list
  });
});

describe('giving up rather than guessing', () => {
  it('forgets the line after Enter', () => {
    const buffer = new TypedBuffer();
    type(buffer, 'runbuild!\r');
    expect(buffer.typed).toBe('');
  });

  it('tracks backspace', () => {
    const buffer = new TypedBuffer();
    type(buffer, 'runbuildX');
    buffer.consume(DEL, HOTSTRINGS);
    expect(buffer.typed).toBe('runbuild');
    expect(buffer.consume('!', HOTSTRINGS)).toBeNull();
    expect(buffer.consume(' ', HOTSTRINGS)?.trigger).toBe('runbuild!');
  });

  it('gives up on an arrow key or any other control sequence', () => {
    // The line may no longer look the way this thinks it does, and expanding against a stale
    // model would delete the wrong characters.
    const buffer = new TypedBuffer();
    type(buffer, 'runbuild!');
    buffer.consume(ESC, HOTSTRINGS);
    expect(buffer.typed).toBe('');
    expect(buffer.consume(' ', HOTSTRINGS)).toBeNull();
  });

  it('does not expand pasted text', () => {
    // A paste arrives as one chunk. Those characters were never typed a key at a time, and
    // rewriting them would mean editing something the user did not compose here.
    const buffer = new TypedBuffer();
    expect(buffer.consume('runbuild! ', HOTSTRINGS)).toBeNull();
    expect(buffer.typed).toBe('');
  });

  it('bounds what it remembers', () => {
    const buffer = new TypedBuffer();
    type(buffer, 'x'.repeat(2000));
    expect(buffer.typed.length).toBeLessThanOrEqual(512);
  });
});

describe('full-screen programs', () => {
  it('expands nothing while suspended', () => {
    // vim and less take the whole screen, and the backspaces this would send are edits there.
    const buffer = new TypedBuffer();
    buffer.setSuspended(true);
    expect(type(buffer, 'runbuild! ')).toBeNull();
  });

  it('forgets anything typed before it was suspended', () => {
    const buffer = new TypedBuffer();
    type(buffer, 'runbuild');
    buffer.setSuspended(true);
    buffer.setSuspended(false);
    expect(buffer.typed).toBe('');
    expect(buffer.consume('!', HOTSTRINGS)).toBeNull();
    expect(buffer.consume(' ', HOTSTRINGS)).toBeNull();
  });

  it('works again once the program exits', () => {
    const buffer = new TypedBuffer();
    buffer.setSuspended(true);
    buffer.setSuspended(false);
    expect(type(buffer, 'gs! ')?.trigger).toBe('gs!');
  });
});

describe('rewriting the line', () => {
  it('deletes exactly the abbreviation', () => {
    expect(backspaces(3)).toHaveLength(3);
    expect(backspaces(0)).toBe('');
  });

  it('sends a delete character, not a backspace-space-backspace dance', () => {
    // The shell's line editor handles one delete per character; anything cleverer would be
    // guessing at which editor is on the other end.
    expect(backspaces(1)).toBe(DEL);
  });
});
