import { describe, expect, it } from 'vitest';
import { TurnTracker } from './agent-turns.js';

describe('agent turns', () => {
  it('measures from the first working event to the stop', () => {
    const t = new TurnTracker();
    expect(t.observe('s', 'working', 'idle', 1_000)).toBe(null);
    expect(t.observe('s', 'idle', 'working', 61_000)).toEqual({
      durationMs: 60_000,
      failed: false,
    });
  });

  it('does not restart the clock on every tool call', () => {
    // A turn running a hundred tools would otherwise be measured from the last one, and report
    // seconds for something that took an hour.
    const t = new TurnTracker();
    t.observe('s', 'working', 'idle', 1_000);
    for (let at = 2_000; at < 60_000; at += 2_000) t.observe('s', 'working', 'working', at);
    expect(t.observe('s', 'idle', 'working', 61_000)?.durationMs).toBe(60_000);
  });

  it('reports a failed turn as failed', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0);
    expect(t.observe('s', 'failed', 'working', 5_000)).toEqual({ durationMs: 5_000, failed: true });
  });

  it('says nothing about an idle that followed no work', () => {
    // An agent CLI reporting idle at startup has not finished anything.
    const t = new TurnTracker();
    expect(t.observe('s', 'idle', undefined, 1_000)).toBe(null);
  });

  it('says nothing twice for one turn', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0);
    expect(t.observe('s', 'idle', 'working', 9_000)).not.toBe(null);
    expect(t.observe('s', 'idle', 'idle', 10_000)).toBe(null);
  });

  it('keeps concurrent sessions apart', () => {
    const t = new TurnTracker();
    t.observe('a', 'working', undefined, 0);
    t.observe('b', 'working', undefined, 5_000);
    expect(t.observe('b', 'idle', 'working', 6_000)?.durationMs).toBe(1_000);
    expect(t.observe('a', 'idle', 'working', 10_000)?.durationMs).toBe(10_000);
  });

  it('starts a new turn after the last one ended', () => {
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0);
    t.observe('s', 'idle', 'working', 1_000);
    t.observe('s', 'working', 'idle', 5_000);
    expect(t.observe('s', 'idle', 'working', 8_000)?.durationMs).toBe(3_000);
  });

  it('restarts the clock once the person has answered', () => {
    /**
     * The measurement is how long the agent kept somebody waiting, not how long they were at
     * lunch. A turn that paused for a question at minute two and was answered forty minutes
     * later would otherwise report forty two minutes of agent work.
     */
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0);
    t.observe('s', 'waiting', 'working', 120_000);
    t.observe('s', 'working', 'waiting', 2_520_000);
    expect(t.observe('s', 'idle', 'working', 2_580_000)?.durationMs).toBe(60_000);
  });

  it('treats waiting for a person as part of the turn', () => {
    // The turn is not over: it is blocked on the human, and the clock keeps running because the
    // thing being measured is how long until they could stop waiting.
    const t = new TurnTracker();
    t.observe('s', 'working', undefined, 0);
    expect(t.observe('s', 'waiting', 'working', 3_000)).toBe(null);
    expect(t.observe('s', 'idle', 'waiting', 9_000)?.durationMs).toBe(9_000);
  });
});
