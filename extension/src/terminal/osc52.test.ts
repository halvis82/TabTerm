import { describe, expect, it } from 'vitest';
import { MAX_COPY_CHARS, describeCopy, parseOsc52 } from './osc52.js';

const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('a program asking to copy', () => {
  it('copies the text, whichever clipboard it names', () => {
    expect(parseOsc52(`c;${b64('hello')}`)).toEqual({ kind: 'write', text: 'hello' });
    expect(parseOsc52(`;${b64('hello')}`)).toEqual({ kind: 'write', text: 'hello' });
    expect(parseOsc52(`p;${b64('x y')}`)).toEqual({ kind: 'write', text: 'x y' });
  });

  it('keeps text that is not ASCII, and lines', () => {
    expect(parseOsc52(`c;${b64('blåbær\nøl')}`)).toEqual({ kind: 'write', text: 'blåbær\nøl' });
  });

  it('never answers a request to read the clipboard', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'ignored', reason: 'read' });
  });

  it('does not let a program clear what somebody copied', () => {
    expect(parseOsc52('c;')).toEqual({ kind: 'ignored', reason: 'clear' });
  });

  it('ignores what is not base64, and what is too large to be a copy', () => {
    expect(parseOsc52('c;not base64!!').kind).toBe('ignored');
    expect(parseOsc52('nonsense').kind).toBe('ignored');
    expect(parseOsc52(`c;${'A'.repeat(MAX_COPY_CHARS * 2)}`)).toEqual({
      kind: 'ignored',
      reason: 'too-large',
    });
  });
});

describe('the notice', () => {
  it('quotes a short copy and counts a long one', () => {
    expect(describeCopy('main.ts')).toBe('Copied "main.ts" from the program');
    expect(describeCopy('a\nb\nc\n')).toBe('Copied 3 lines from the program');
    expect(describeCopy('x'.repeat(50))).toBe('Copied 50 characters from the program');
  });
});
