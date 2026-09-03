import { describe, expect, it } from 'vitest';
import { checkShape, parseShape, previewPanes } from './template-syntax.js';

const shapeOf = (text: string) => parseShape(text).shape;

describe('writing a layout down', () => {
  it('reads side by side and stacked', () => {
    expect(shapeOf('1+2')).toEqual({
      kind: 'split',
      direction: 'horizontal',
      children: [
        { kind: 'session', id: 1 },
        { kind: 'session', id: 2 },
      ],
    });
    expect(shapeOf('1/2')).toEqual({
      kind: 'split',
      direction: 'vertical',
      children: [
        { kind: 'session', id: 1 },
        { kind: 'session', id: 2 },
      ],
    });
  });

  it('groups with brackets, which is what makes the two examples different', () => {
    // Two side by side above one.
    const above = previewPanes(shapeOf('(1+2)/3'));
    expect(above.find((p) => p.id === 3)).toMatchObject({ x: 0, y: 0.5, width: 1, height: 0.5 });
    // Two stacked beside one.
    const beside = previewPanes(shapeOf('(1/2)+3'));
    expect(beside.find((p) => p.id === 3)).toMatchObject({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });

  it('takes a single number as a single pane', () => {
    expect(shapeOf('1')).toEqual({ kind: 'session', id: 1 });
  });

  it('treats the numbers as command names, so the same one twice means both panes run it', () => {
    /**
     * Two panes, one command box. Every pane is still its own terminal: a session is never in
     * two panes at once, which is a rule the whole product rests on. What is shared is the
     * command, not the shell.
     */
    const parsed = parseShape('1+1');
    expect(parsed.sessions).toEqual([1]);
    expect(previewPanes(parsed.shape)).toHaveLength(2);
  });

  it('lists sessions in the order they first appear', () => {
    expect(parseShape('(3+1)/3').sessions).toEqual([3, 1]);
  });

  it('ignores spaces, since people type them', () => {
    expect(shapeOf(' (1 + 2) / 3 ')).toEqual(shapeOf('(1+2)/3'));
  });
});

describe('saying what is wrong, in words', () => {
  const why = (text: string) => {
    const result = checkShape(text);
    return 'error' in result ? result.error : null;
  };

  it('asks for something when there is nothing', () => {
    expect(why('')).toContain('Write a shape');
  });

  it('names an unclosed bracket', () => {
    expect(why('(1+2')).toContain('never closed');
  });

  it('names what it found instead of a number', () => {
    expect(why('1+')).toContain('the end');
    expect(why('+1')).toContain('"+"');
  });

  it('rejects trailing rubbish rather than ignoring it', () => {
    expect(why('1+2)')).toContain('Did not understand');
  });

  it('keeps the numbers to what a person can hold in their head', () => {
    expect(why('0')).toContain('1 to 9');
    expect(why('1+2+3+4+5+6+7')).toContain('Six panes');
    // Counted as panes, not as distinct numbers: `1+1+1+1+1+1+1` is seven terminals.
    expect(why('1+1+1+1+1+1+1')).toContain('Six panes');
  });

  it('accepts a good one', () => {
    expect(why('(1+2)/3')).toBe(null);
  });
});

describe('previewing a shape', () => {
  it('fills the whole area, with no gaps and no overlap', () => {
    for (const text of ['1', '1+2', '1/2', '(1+2)/3', '(1/2)+3', '1+2+3', '(1+2)/(3+4)']) {
      const panes = previewPanes(shapeOf(text));
      const area = panes.reduce((sum, p) => sum + p.width * p.height, 0);
      expect(area, text).toBeCloseTo(1, 5);
      for (const p of panes) {
        expect(p.x + p.width, text).toBeLessThanOrEqual(1.000001);
        expect(p.y + p.height, text).toBeLessThanOrEqual(1.000001);
      }
    }
  });

  it('gives four quarters for two rows of two', () => {
    const panes = previewPanes(shapeOf('(1+2)/(3+4)'));
    expect(panes).toHaveLength(4);
    for (const p of panes) {
      expect(p.width).toBeCloseTo(0.5, 5);
      expect(p.height).toBeCloseTo(0.5, 5);
    }
  });
});
