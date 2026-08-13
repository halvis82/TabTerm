import { describe, expect, it } from 'vitest';
import { clampTimeout } from './server.js';

describe('the background timeout', () => {
  it('keeps forever as a real answer', () => {
    expect(clampTimeout(null)).toBe(null);
  });

  it('treats zero and negatives as forever rather than as instant', () => {
    // Reading a stored 0 as "end every session immediately" would delete somebody's work on
    // startup, so the harmless interpretation wins.
    expect(clampTimeout(0)).toBe(null);
    expect(clampTimeout(-5)).toBe(null);
  });

  it('refuses a timeout shorter than switching tabs takes', () => {
    expect(clampTimeout(5)).toBe(60);
  });

  it('caps at a day, since longer is what forever is for', () => {
    expect(clampTimeout(99 * 60 * 60)).toBe(24 * 60 * 60);
  });

  it('keeps an ordinary value exactly', () => {
    expect(clampTimeout(15 * 60)).toBe(900);
  });
});
