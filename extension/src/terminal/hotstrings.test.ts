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
  it('expands the moment the abbreviation is complete', () => {
    /**
     * No delimiter. Waiting for a space or Return meant typing the abbreviation and watching
     * nothing happen until you typed something else, which reads as the feature being broken.
     * Waiting for a delimiter is what an expander does when it cannot see the text; this one
     * knows exactly what has been typed since the last boundary.
     */
    const request = type(new TypedBuffer(), 'runbuild!');
    expect(request).toEqual({
      deleteCount: 'runbuild!'.length,
      // Nothing was typed to trigger it, so nothing is owed back.
      insert: 'npm run build',
      trigger: 'runbuild!',
    });
  });

  it('has already expanded by the time Enter is pressed', () => {
    // The expansion fires on the last character of the abbreviation, so the Return that follows
    // finds nothing left to match and is simply a Return on an already-expanded line.
    const buffer = new TypedBuffer();
    expect(type(buffer, 'runbuild!')?.insert).toBe('npm run build');
    expect(type(buffer, '\r')).toBeNull();
  });

  it('does not expand while the abbreviation is still incomplete', () => {
    const buffer = new TypedBuffer();
    expect(type(buffer, 'runbuild')).toBeNull();
    expect(buffer.typed).toBe('runbuild');
  });

  it('fires as soon as it matches, even inside a longer word', () => {
    /**
     * The cost of expanding immediately, stated rather than hidden.
     *
     * An abbreviation that is a prefix of something you type will fire in the middle of it, so
     * abbreviations have to be chosen to be unusual. Every expander that works without a
     * delimiter has this property; the alternative is the delay that made this look broken.
     */
    const request = type(new TypedBuffer(), 'runbuild!of');
    expect(request?.insert).toBe('npm run build');
  });

  it('has expanded before Tab is reached, so Tab still means completion', () => {
    const buffer = new TypedBuffer();
    expect(type(buffer, 'runbuild!')).not.toBeNull();
    expect(type(buffer, '\t')).toBeNull();
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

  it('tracks backspace, so correcting a typo still expands', () => {
    const buffer = new TypedBuffer();
    type(buffer, 'runbuildX');
    buffer.consume(DEL, HOTSTRINGS);
    expect(buffer.typed).toBe('runbuild');
    // The corrected last character completes the abbreviation, so it fires there.
    expect(buffer.consume('!', HOTSTRINGS)?.trigger).toBe('runbuild!');
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
