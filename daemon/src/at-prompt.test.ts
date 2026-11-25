import { describe, expect, it } from 'vitest';
import { atPrompt } from './at-prompt.js';

describe('atPrompt', () => {
  it('sets the typed line aside with push-line when the integration is there', () => {
    expect(atPrompt("cd '/a b'", true)).toBe("\u001bqcd '/a b'\r");
  });
  it('clears the line first without it', () => {
    expect(atPrompt('cd /a', false)).toBe('\u0005\u0015cd /a\r');
  });
});
