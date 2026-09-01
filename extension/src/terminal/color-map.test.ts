import { describe, expect, it } from 'vitest';
import { RECENT_LIMIT, colorAt, hslToHex, remember } from './color-map.js';

describe('the color map', () => {
  it('converts to hex the way every other tool does', () => {
    expect(hslToHex(0, 1, 0.5)).toBe('#ff0000');
    expect(hslToHex(120, 1, 0.5)).toBe('#00ff00');
    expect(hslToHex(240, 1, 0.5)).toBe('#0000ff');
    expect(hslToHex(0, 0, 0)).toBe('#000000');
    expect(hslToHex(0, 0, 1)).toBe('#ffffff');
  });

  it('gives a usable color anywhere on it, including the corners', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
    ] as const) {
      expect(colorAt(x, y)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('never reaches white or black, which are both useless as a highlight', () => {
    // White is unreadable behind white text, black is invisible as one.
    expect(colorAt(0.5, 0)).not.toBe('#ffffff');
    expect(colorAt(0.5, 1)).not.toBe('#000000');
  });

  it('gets darker downwards and changes hue across', () => {
    const value = (hex: string): number =>
      Math.max(
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16),
      );
    expect(value(colorAt(0.5, 0))).toBeGreaterThan(value(colorAt(0.5, 1)));
    expect(colorAt(0.1, 0.5)).not.toBe(colorAt(0.6, 0.5));
  });

  it('takes a point outside it as the nearest edge, rather than a nonsense color', () => {
    expect(colorAt(-3, -3)).toBe(colorAt(0, 0));
    expect(colorAt(9, 9)).toBe(colorAt(1, 1));
  });
});

describe('remembering the last few colors', () => {
  it('puts the newest first', () => {
    expect(remember(['#111111'], '#222222')).toEqual(['#222222', '#111111']);
  });

  it('moves one that is already there rather than repeating it', () => {
    expect(remember(['#111111', '#222222'], '#111111')).toEqual(['#111111', '#222222']);
    // Case is not a difference anybody means.
    expect(remember(['#AABBCC'], '#aabbcc')).toEqual(['#aabbcc']);
  });

  it('keeps only as many as fit beside a text box', () => {
    let list: string[] = [];
    for (const c of ['#1', '#2', '#3', '#4', '#5', '#6', '#7']) list = remember(list, c);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toBe('#7');
  });
});
