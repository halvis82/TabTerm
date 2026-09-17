import { describe, expect, it } from 'vitest';
import { plainText } from './server.js';

const ESC = '';
const BEL = '';

describe('turning a serialized screen into something readable', () => {
  it('drops the mode switches a screen carries', () => {
    // This exact sequence was appearing beside the prompt in session previews, which reads as
    // a bug in whatever is drawing them.
    expect(plainText(`(base) user@mac ~ % ${ESC}[?2004h`)).toEqual(['(base) user@mac ~ %']);
  });

  it('drops colors while keeping the text they colored', () => {
    expect(plainText(`${ESC}[32mpassed${ESC}[0m 12 tests`)).toEqual(['passed 12 tests']);
  });

  it('drops an OSC title without eating what follows it', () => {
    expect(plainText(`${ESC}]0;a title${BEL}hello`)).toEqual(['hello']);
  });

  it('drops an OSC terminated by ST as well as by BEL', () => {
    expect(plainText(`${ESC}]7;file://host/tmp${ESC}\\after`)).toEqual(['after']);
  });

  it('drops blank and whitespace-only lines', () => {
    expect(plainText('one\n   \n\ntwo')).toEqual(['one', 'two']);
  });

  it('keeps ordinary text exactly, including leading indentation', () => {
    expect(plainText('npm test\n  ok 3')).toEqual(['npm test', '  ok 3']);
  });

  it('leaves nothing behind for a screen that is only control sequences', () => {
    expect(plainText(`${ESC}[2J${ESC}[H`)).toEqual([]);
  });
});

/**
 * A gap a program drew by moving the cursor is a gap.
 *
 * A full screen interface lays itself out by jumping the cursor rather than by writing spaces,
 * because it is cheaper. Deleting those along with the colours closed every gap, so a preview of
 * an agent read "Configdialogdismissed" and "bypasspermissionson". Several hundred of those
 * sequences in one screen, counted in a real database.
 */
describe('gaps a program drew rather than typed', () => {
  const ESC = String.fromCharCode(27);

  it('keeps the space where the cursor was moved across', () => {
    expect(plainText(`Config${ESC}[1Cdialog${ESC}[1Cdismissed`)).toEqual([
      'Config dialog dismissed',
    ]);
  });

  it('and a wider jump is as wide as it was drawn', () => {
    expect(plainText(`left${ESC}[12Cright`)).toEqual([`left${' '.repeat(12)}right`]);
  });

  it('and a jump with no number means one column', () => {
    expect(plainText(`a${ESC}[Cb`)).toEqual(['a b']);
  });

  it('and still drops the colours and the modes around it', () => {
    expect(plainText(`${ESC}[32mgreen${ESC}[0m${ESC}[2Cword${ESC}[?2004h`)).toEqual([
      'green  word',
    ]);
  });
});
