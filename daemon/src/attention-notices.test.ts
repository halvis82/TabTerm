import { describe, expect, it } from 'vitest';
import { AttentionNotices, QUIET_MS } from './attention-notices.js';

/**
 * Five desktop notifications in five seconds, all saying the same thing, from tabs where nothing
 * was happening. This is the gate that was missing.
 */
describe('when an agent needing somebody is worth interrupting them', () => {
  it('raises one when a session starts waiting', () => {
    const g = new AttentionNotices();
    expect(g.shouldRaise('a', 'waiting', 'working', 0)).toBe(true);
  });

  it('says nothing when told again what it already knew', () => {
    // The fault as reported. An agent's hooks fire when the agent wants somebody, and they fire
    // again, and a subagent fires its own. Every one of them became a notification.
    const g = new AttentionNotices();
    expect(g.shouldRaise('a', 'waiting', 'working', 0)).toBe(true);
    expect(g.shouldRaise('a', 'waiting', 'waiting', 1000)).toBe(false);
    expect(g.shouldRaise('a', 'waiting', 'waiting', 2000)).toBe(false);
    expect(g.shouldRaise('a', 'waiting', 'waiting', 3000)).toBe(false);
  });

  it('stays quiet for a session that flaps in and out of waiting', () => {
    // Entering the state repeatedly is still not news repeatedly. An agent with nothing to do
    // goes on having nothing to do, and the person was told the first time.
    const g = new AttentionNotices();
    expect(g.shouldRaise('a', 'waiting', 'working', 0)).toBe(true);
    expect(g.shouldRaise('a', 'waiting', 'working', 5_000)).toBe(false);
    expect(g.shouldRaise('a', 'waiting', 'working', 30_000)).toBe(false);
    expect(g.shouldRaise('a', 'waiting', 'working', QUIET_MS + 1)).toBe(true);
  });

  it('never holds back an approval, which blocks the agent until it is answered', () => {
    const g = new AttentionNotices();
    expect(g.shouldRaise('a', 'approval', 'working', 0)).toBe(true);
    expect(g.shouldRaise('a', 'approval', 'working', 100)).toBe(true);
    // Still not for being told the same thing twice, which is a repeat and not a second request.
    expect(g.shouldRaise('a', 'approval', 'approval', 200)).toBe(false);
  });

  it('keeps sessions apart, since two agents waiting is two things to know', () => {
    const g = new AttentionNotices();
    expect(g.shouldRaise('a', 'waiting', 'working', 0)).toBe(true);
    expect(g.shouldRaise('b', 'waiting', 'working', 10)).toBe(true);
  });

  it('has nothing to say about any other state', () => {
    const g = new AttentionNotices();
    expect(g.shouldRaise('a', 'working', 'idle', 0)).toBe(false);
    expect(g.shouldRaise('a', 'idle', 'working', 0)).toBe(false);
  });

  it('forgets a session that has gone', () => {
    const g = new AttentionNotices();
    g.shouldRaise('a', 'waiting', 'working', 0);
    g.forget('a');
    expect(g.shouldRaise('a', 'waiting', 'working', 10)).toBe(true);
  });
});
