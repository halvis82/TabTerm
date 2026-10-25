import { describe, expect, it } from 'vitest';
import {
  MAX_COPY_LINES,
  isAgentCommand,
  limitLines,
  readLines,
  saneCopyLines,
} from './command-output.js';

/** A buffer of rows, each either a fresh line or the terminal's wrap of the one before. */
function rows(spec: readonly (string | { wrapped: string })[]) {
  const lines = spec.map((r) =>
    typeof r === 'string'
      ? { isWrapped: false, translateToString: () => r }
      : { isWrapped: true, translateToString: () => r.wrapped },
  );
  return (row: number) => lines[row];
}

describe('what Copy output copies', () => {
  it('joins a line the terminal wrapped back into the one line that was printed', () => {
    const get = rows(['first', 'a long line that', { wrapped: ' kept going' }, 'last']);
    expect(readLines(get, 0, 3)).toEqual(['first', 'a long line that kept going', 'last']);
  });

  it('keeps blank lines inside the output and drops them at its edges', () => {
    const get = rows(['', 'one', '', 'two', '   ', '']);
    expect(readLines(get, 0, 5)).toEqual(['one', '', 'two']);
  });

  it('drops the padding a row carries after its text', () => {
    expect(readLines(rows(['text   ']), 0, 0)).toEqual(['text']);
  });

  it('keeps the newest lines when there are more than the limit, and says so', () => {
    const out = limitLines(['a', 'b', 'c', 'd'], 2);
    expect(out).toEqual({ text: 'c\nd', lines: 2, partial: true });
    expect(limitLines(['a', 'b'], 2).partial).toBe(false);
  });
});

describe('which commands get the button', () => {
  it('leaves agents out, however they were started', () => {
    expect(isAgentCommand('claude')).toBe(true);
    expect(isAgentCommand('codex --full-auto')).toBe(true);
    expect(isAgentCommand('/opt/homebrew/bin/claude -c')).toBe(true);
    expect(isAgentCommand('DEBUG=1 npx @openai/codex')).toBe(true);
    expect(isAgentCommand('npx codex')).toBe(true);
    expect(isAgentCommand('FOO=bar claude')).toBe(true);
  });

  it('and keeps everything else, including a command that mentions one', () => {
    expect(isAgentCommand('ls -la')).toBe(false);
    expect(isAgentCommand('npm test')).toBe(false);
    expect(isAgentCommand('grep claude notes.txt')).toBe(false);
    expect(isAgentCommand('')).toBe(false);
  });
});

describe('the limit', () => {
  it('is bounded whatever is stored', () => {
    expect(saneCopyLines(10 ** 9)).toBe(MAX_COPY_LINES);
    expect(saneCopyLines('nonsense')).toBe(10_000);
    expect(saneCopyLines(-5)).toBe(10_000);
    expect(saneCopyLines(5000)).toBe(5000);
  });
});
