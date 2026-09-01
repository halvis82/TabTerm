import { describe, expect, it } from 'vitest';
import { markerBlock } from './marker-block.js';

const ESC = String.fromCharCode(27);
const lines = (s: string) => s.split('\r\n').filter((l) => l !== '');

describe('a landmark in the output', () => {
  it('paints every cell of its lines, so it is findable at a glance', () => {
    const block = markerBlock({ label: '', color: '#7aa2f7', cols: 40 });
    for (const line of lines(block)) {
      expect(line).toContain(ESC + '[48;2;122;162;247m');
    }
  });

  it('carries the label it was given', () => {
    expect(markerBlock({ label: 'before the deploy', cols: 60 })).toContain('before the deploy');
  });

  it('reads a label on a light background in dark ink, and the reverse', () => {
    // Perceived brightness, because green looks far lighter than blue at the same value.
    expect(markerBlock({ label: 'x', color: '#f0f0a0', cols: 30 })).toContain('38;2;20;20;20m');
    expect(markerBlock({ label: 'x', color: '#202060', cols: 30 })).toContain('38;2;250;250;250m');
  });

  it('resets color at the end of every line, so nothing after it is tinted', () => {
    for (const line of lines(markerBlock({ label: 'x', cols: 30 }))) {
      expect(line.endsWith(ESC + '[0m')).toBe(true);
    }
  });

  it('starts on a fresh line, so it never lands halfway along one being written', () => {
    expect(markerBlock({ label: 'x', cols: 30 }).startsWith('\r\n')).toBe(true);
  });

  it('refuses a color that is not a hex triple, rather than guessing', () => {
    expect(markerBlock({ label: 'x', color: 'red', cols: 30 })).toContain('48;2;122;162;247m');
  });

  it('stops one column short, so the line does not wrap into a blank one', () => {
    // A full width line wraps by itself, and the newline after it then produced a blank line
    // between every bar, so one landmark was read as three.
    const bar = markerBlock({ label: '', cols: 40 }).split('\r\n')[1] ?? '';
    // Built from the escape rather than written as a literal, since a control character in a
    // regular expression is exactly the kind of thing that is invisible when it is wrong.
    const painted = bar.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
    expect(painted).toHaveLength(39);
  });

  it('keeps a very wide terminal from producing an enormous block', () => {
    expect(markerBlock({ label: '', cols: 100000 }).split('\r\n')[1]?.length).toBeLessThan(2000);
  });
});
