import { describe, expect, it } from 'vitest';
import { TurnTracker, looksLikeInterrupt } from './agent-turns.js';

const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);

/**
 * An agent that somebody stops part way through.
 *
 * The report: "it doesn't register if a user interrupts and sends a new prompt. the timer is just
 * kept going." Nothing reports an interrupt, because `Stop` fires when a response finishes rather
 * than when a person stops one. So the agent still looks like it is working when the next prompt
 * arrives, and the guard that stops a queued prompt restarting the clock stopped this one too.
 */
describe('an agent that somebody interrupts', () => {
  it('starts a new turn for the prompt that follows, though the agent never said it stopped', () => {
    const turns = new TurnTracker();
    turns.observe('s1', 'working', 'idle', 1_000, 'UserPromptSubmit');
    expect(turns.startedAt('s1')).toBe(1_000);

    turns.interrupt('s1');
    expect(turns.startedAt('s1')).toBeUndefined();

    // The new prompt, arriving while the agent still looks like it is working.
    turns.observe('s1', 'working', 'working', 9_000, 'UserPromptSubmit');
    expect(turns.startedAt('s1')).toBe(9_000);
  });

  /*
   * And the rule the interrupt has to get past is still there for the case it was written for: a
   * prompt queued onto a turn already running is answered in that turn, so the wait is measured
   * from the first of them rather than the second.
   */
  it('and a prompt merely queued onto a running turn still does not restart it', () => {
    const turns = new TurnTracker();
    turns.observe('s2', 'working', 'idle', 1_000, 'UserPromptSubmit');
    turns.observe('s2', 'working', 'working', 5_000, 'UserPromptSubmit');
    expect(turns.startedAt('s2')).toBe(1_000);
  });

  it('and one interrupt lets exactly one prompt through', () => {
    const turns = new TurnTracker();
    turns.observe('s3', 'working', 'idle', 1_000, 'UserPromptSubmit');
    turns.interrupt('s3');
    turns.observe('s3', 'working', 'working', 4_000, 'UserPromptSubmit');
    turns.observe('s3', 'working', 'working', 7_000, 'UserPromptSubmit');
    expect(turns.startedAt('s3')).toBe(4_000);
  });
});

describe('what counts as an interrupt in what somebody typed', () => {
  it('escape on its own does', () => {
    expect(looksLikeInterrupt(ESC)).toBe(true);
  });

  it('and control C does', () => {
    expect(looksLikeInterrupt(CTRL_C)).toBe(true);
  });

  /*
   * An arrow key is an escape too, and somebody moving the cursor through what they are typing
   * has not abandoned the answer they are waiting for.
   */
  it('but an arrow key does not', () => {
    expect(looksLikeInterrupt(`${ESC}[A`)).toBe(false);
    expect(looksLikeInterrupt(`${ESC}[B`)).toBe(false);
    expect(looksLikeInterrupt(`${ESC}OP`)).toBe(false);
  });

  it('and ordinary typing does not', () => {
    expect(looksLikeInterrupt('write me a haiku\r')).toBe(false);
  });
});
