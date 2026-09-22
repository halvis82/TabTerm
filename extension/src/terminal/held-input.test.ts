import { describe, expect, it } from 'vitest';
import { HeldInput } from './held-input.js';

/**
 * The shape of the fault this exists for: a resumed agent draws its input box seconds before it
 * will act on anything, and a prompt typed into that window came back with its first characters
 * missing and the turn reported as interrupted.
 */
describe('what is typed at an agent that is still starting', () => {
  it('is held rather than sent', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    expect(held.take('s1', 'hello')).toBe(true);
    expect(held.release(500)).toEqual([]);
  });

  it('and goes nowhere near a session nobody is holding', () => {
    const held = new HeldInput();
    expect(held.take('a shell', 'ls\r')).toBe(false);
    expect(held.holding('a shell')).toBe(false);
  });

  /*
   * Ready is: it has spoken, it has been quiet since, and a floor has passed. The box appears
   * inside that floor, which is exactly the moment that was losing prompts.
   */
  it('is delivered once the pane has spoken and gone quiet', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    held.take('s1', 'what changed today');
    held.spoke('s1', 1500);
    expect(held.release(1900)).toEqual([]);
    expect(held.release(2600)).toEqual([{ sessionId: 's1', text: 'what changed today' }]);
  });

  it('and not while it is still printing', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    held.take('s1', 'a prompt');
    for (let at = 500; at <= 5000; at += 400) {
      held.spoke('s1', at);
      expect(held.release(at + 100)).toEqual([]);
    }
  });

  it('and never sooner than the floor, however quiet it has been', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    held.take('s1', 'x');
    held.spoke('s1', 10);
    expect(held.release(1000)).toEqual([]);
    expect(held.release(2001)).toHaveLength(1);
  });

  /*
   * And an agent that never stops printing still gets what was typed. Late is a bad outcome and
   * never is a worse one.
   */
  it('gives up holding rather than holding forever', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    held.take('s1', 'answer me');
    for (let at = 0; at < 12_000; at += 200) held.spoke('s1', at);
    expect(held.release(12_001)).toEqual([{ sessionId: 's1', text: 'answer me' }]);
  });

  it('keeps what was typed in the order it was typed', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    for (const ch of 'one two\r') held.take('s1', ch);
    held.spoke('s1', 100);
    expect(held.release(3000)[0]?.text).toBe('one two\r');
  });

  it('releases a session only once', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    held.spoke('s1', 100);
    expect(held.release(3000)).toHaveLength(1);
    expect(held.release(4000)).toEqual([]);
    expect(held.holding('s1')).toBe(false);
  });

  it('and a session that goes gives back what was typed at it', () => {
    const held = new HeldInput();
    held.begin('s1', 0);
    held.take('s1', 'typed at a pane that closed');
    expect(held.drop('s1')).toBe('typed at a pane that closed');
    expect(held.holding('s1')).toBe(false);
    expect(held.size).toBe(0);
  });

  it('counts what it is holding, so nothing has to poll for nothing', () => {
    const held = new HeldInput();
    expect(held.size).toBe(0);
    held.begin('s1', 0);
    held.begin('s2', 0);
    expect(held.size).toBe(2);
  });
});
