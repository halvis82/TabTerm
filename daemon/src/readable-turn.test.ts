import { describe, expect, it } from 'vitest';
import { isMachinery, readableTurn } from './readable-turn.js';

/**
 * The rows he photographed, which is what these are written against.
 *
 * The list exists to tell one stored session from another, and those rows were made of
 * `<task-notification>` wrappers and of a table flattened into `| 8 | 52.0, 46.0, 42.3 |`. Neither
 * is a sentence, and between them they filled the space the sentences needed.
 */
describe('a turn as a person reads it', () => {
  it('drops a turn that is only a monitor firing', () => {
    const noise =
      '<task-notification> <task-id>byww8r4el</task-id> <summary>Monitor event: ' +
      '"Android sweep stage 4b variants and failures"</summary> <event>[Monitor expired after ' +
      '30m with 6 events delivered. Re-arm it if you still need the watch.]</event> ' +
      '</task-notification>';
    expect(isMachinery(noise)).toBe(true);
  });

  it('and keeps what a person wrote around one', () => {
    const mixed =
      'have a look at this please <task-notification> <task-id>x</task-id> </task-notification>';
    expect(isMachinery(mixed)).toBe(false);
    expect(readableTurn(mixed)).toBe('have a look at this please');
  });

  it('keeps the emphasis as words rather than as stars', () => {
    expect(readableTurn('**This is a correction** and it matters')).toBe(
      'This is a correction and it matters',
    );
  });

  /*
   * A table cannot be drawn in one line of a list, so its cells are joined the way a sentence
   * joins things. The rule underneath it says nothing at all and goes.
   */
  it('turns a table into something that reads as a sentence', () => {
    const table = [
      '| people per side | three independent halves | spread |',
      '|---|---|---|',
      '| 8 | 52.0, 46.0, 42.3 | 9.7 points |',
    ].join('\n');
    expect(readableTurn(table)).toBe(
      'people per side · three independent halves · spread · 8 · 52.0, 46.0, 42.3 · 9.7 points',
    );
  });

  it('and says code is code rather than pasting it', () => {
    expect(readableTurn('here is the fix\n```js\nconst x = 1;\n```\nthat is all')).toBe(
      'here is the fix (code) that is all',
    );
  });

  it('keeps a heading as its words', () => {
    expect(readableTurn('## What changed\nthe floor moved')).toBe('What changed the floor moved');
  });

  it('and a bullet list as a line', () => {
    expect(readableTurn('- one\n- two')).toBe('one · two');
  });

  it('and inline code as what it says', () => {
    expect(readableTurn('run `npm test` first')).toBe('run npm test first');
  });

  it('and a link as its words, not its address', () => {
    expect(readableTurn('see [the README](https://example.com/a/b) for more')).toBe(
      'see the README for more',
    );
  });

  /*
   * Ordinary prose is not touched. Everything above removes something; nothing invents anything,
   * and a sentence that happens to contain a comparison is still a sentence.
   */
  it('leaves an ordinary sentence exactly as it was', () => {
    const plain = 'Nothing is running. Two things to settle before more generator cells.';
    expect(readableTurn(plain)).toBe(plain);
  });

  it('and a comparison is not a tag', () => {
    expect(readableTurn('if x < 3 and y > 4 then stop')).toBe('if x < 3 and y > 4 then stop');
  });

  it('and an empty turn is machinery, since there is nothing to read', () => {
    expect(isMachinery('   ')).toBe(true);
  });
});
