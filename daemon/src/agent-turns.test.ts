import { describe, expect, it } from 'vitest';
import { TurnTracker } from './agent-turns.js';

/**
 * A turn is timed from the prompt.
 *
 * These checks carry the hook name, because that is the thing that says a turn began. Two hooks
 * mean "working" and only `UserPromptSubmit` means "this is where the person started waiting".
 */
describe('agent turns', () => {
  it('measures from the prompt to the stop', () => {
    const t = new TurnTracker();
    expect(t.observe('s', 'working', 'idle', 1_000, 'UserPromptSubmit')).toBe(null);
    expect(t.observe('s', 'idle', 'working', 61_000, 'Stop')).toEqual({
      durationMs: 60_000,
      failed: false,
    });
  });

  it('does not restart the clock on every tool call', () => {
    // A turn running a hundred tools would otherwise be measured from the last one, and report
    // seconds for something that took an hour.
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 1_000, 'UserPromptSubmit');
    for (let at = 2_000; at < 60_000; at += 2_000) {
      t.observe('s', 'working', 'working', at, 'PreToolUse');
    }
    expect(t.observe('s', 'idle', 'working', 61_000, 'Stop')?.durationMs).toBe(60_000);
  });

  /**
   * The reported bug, as the sequence that produced it.
   *
   * `Notification` is a rest, so the `PreToolUse` after a permission prompt used to look exactly
   * like the start of a new turn. An hour of work reported as the seconds since the last approval,
   * and only turns that never asked anything were right. Fails against the old tracker.
   */
  it('is not restarted by a question in the middle of a turn', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 0, 'UserPromptSubmit');
    t.observe('s', 'working', 'working', 30_000, 'PreToolUse');
    t.observe('s', 'waiting', 'working', 60_000, 'Notification');
    t.observe('s', 'working', 'waiting', 90_000, 'PreToolUse');
    expect(t.observe('s', 'idle', 'working', 120_000, 'Stop')?.durationMs).toBe(120_000);
  });

  it('is not restarted by an approval either', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 0, 'UserPromptSubmit');
    t.observe('s', 'approval', 'working', 10_000, 'PermissionRequest');
    t.observe('s', 'working', 'approval', 40_000, 'PreToolUse');
    expect(t.observe('s', 'idle', 'working', 50_000, 'Stop')?.durationMs).toBe(50_000);
  });

  /**
   * Which is the trade this makes, stated rather than hidden.
   *
   * The number now includes the time the person took to answer, because "took four minutes" is
   * read as four minutes since they asked. The older behavior subtracted their thinking time,
   * which is a defensible number and is not the one the sentence claims. The breakdown belongs in
   * the stats surfaces, where there is room to say both.
   */
  it('includes the time the person spent answering', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 0, 'UserPromptSubmit');
    t.observe('s', 'waiting', 'working', 120_000, 'Notification');
    t.observe('s', 'working', 'waiting', 2_520_000, 'PreToolUse');
    expect(t.observe('s', 'idle', 'working', 2_580_000, 'Stop')?.durationMs).toBe(2_580_000);
  });

  it('measures a prompt queued while it is already working from the first one', () => {
    /*
     * An agent lets you send another prompt while it is thinking, and both are answered in the
     * one turn the person sits through. The second prompt is not a moment anybody started
     * waiting at.
     */
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 0, 'UserPromptSubmit');
    t.observe('s', 'working', 'working', 20_000, 'UserPromptSubmit');
    expect(t.observe('s', 'idle', 'working', 60_000, 'Stop')?.durationMs).toBe(60_000);
  });

  it('reports a failed turn as failed', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0, 'UserPromptSubmit');
    expect(t.observe('s', 'failed', 'working', 5_000, 'Error')).toEqual({
      durationMs: 5_000,
      failed: true,
    });
  });

  it('says nothing about an idle that followed no work', () => {
    // An agent CLI reporting idle at startup has not finished anything.
    const t = new TurnTracker();
    expect(t.observe('s', 'idle', undefined, 1_000, 'Stop')).toBe(null);
  });

  /**
   * And says nothing when it never saw the prompt, which is a real case rather than a hypothetical.
   *
   * A daemon restarted mid-turn, or hooks switched on while an agent was already running. The
   * alternative to silence is a duration measured from whatever this daemon happened to see first,
   * which is the class of wrong number this file exists to prevent.
   */
  it('says nothing when it never saw the prompt', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 0, 'PreToolUse');
    t.observe('s', 'working', 'working', 30_000, 'PreToolUse');
    expect(t.observe('s', 'idle', 'working', 60_000, 'Stop')).toBe(null);
  });

  it('says nothing twice for one turn', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0, 'UserPromptSubmit');
    expect(t.observe('s', 'idle', 'working', 9_000, 'Stop')).not.toBe(null);
    expect(t.observe('s', 'idle', 'idle', 10_000, 'Stop')).toBe(null);
  });

  it('keeps concurrent sessions apart', () => {
    const t = new TurnTracker();
    t.observe('a', 'working', undefined, 0, 'UserPromptSubmit');
    t.observe('b', 'working', undefined, 5_000, 'UserPromptSubmit');
    expect(t.observe('b', 'idle', 'working', 6_000, 'Stop')?.durationMs).toBe(1_000);
    expect(t.observe('a', 'idle', 'working', 10_000, 'Stop')?.durationMs).toBe(10_000);
  });

  it('starts a new turn after the last one ended', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0, 'UserPromptSubmit');
    t.observe('s', 'idle', 'working', 1_000, 'Stop');
    t.observe('s', 'working', 'idle', 5_000, 'UserPromptSubmit');
    expect(t.observe('s', 'idle', 'working', 8_000, 'Stop')?.durationMs).toBe(3_000);
  });

  it('treats waiting for a person as part of the turn', () => {
    // The turn is not over: it is blocked on the human, and the clock keeps running because the
    // thing being measured is how long until they could stop waiting.
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0, 'UserPromptSubmit');
    expect(t.observe('s', 'waiting', 'working', 3_000, 'Notification')).toBe(null);
    expect(t.observe('s', 'idle', 'waiting', 9_000, 'Stop')?.durationMs).toBe(9_000);
  });
});
