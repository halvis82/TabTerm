import { describe, expect, it } from 'vitest';
import { PtyHostClient } from './client.js';
import { initLog } from '../log.js';

/**
 * Input that was thrown away has to reach the person who typed it.
 *
 * The queue for an absent host is bounded, and when it overflows the thing it gives up last is
 * somebody's typing. That is the right order to give things up in, and it is still a loss: the
 * shell carries on, and the next thing typed lands against a command line that is not what its
 * author believes it is.
 *
 * There was a record of it and no way for anybody to see it. The ids were collected, a line went
 * into the log, and `takeLostInput` had no caller in the product at all. A log entry is not error
 * handling for something only the person typing can put right.
 */
describe('input dropped while the host was away', () => {
  it('is announced on the terminal it was typed into', () => {
    initLog('error');
    const client = new PtyHostClient({
      socketPath: '/nonexistent/sock',
      hostScript: '/nonexistent',
    });

    const seen: { sessionId: string; text: string }[] = [];
    client.onData((sessionId, data) => {
      seen.push({ sessionId, text: data.toString('utf8') });
    });

    /**
     * More typing than the queue is allowed to hold, for a session with nowhere to send it.
     *
     * Nothing is connected, so every write is queued, and the bound is what forces the drop.
     */
    for (let i = 0; i < 40_000; i++) client.write('typed-into-me', `line ${String(i)}\n`);

    // What the daemon does when it gets a host back: catch up, then tell anybody who lost input.
    client.reconciled();

    const told = seen.filter((s) => s.sessionId === 'typed-into-me');
    expect(told.length, 'the terminal must be told something').toBeGreaterThan(0);
    expect(told[0]?.text).toContain('not delivered');
    expect(told[0]?.text, 'and it must say what to do about it').toContain('Check the line above');
  });

  it('says nothing when nothing was lost', () => {
    initLog('error');
    const client = new PtyHostClient({
      socketPath: '/nonexistent/sock',
      hostScript: '/nonexistent',
    });
    const seen: string[] = [];
    client.onData((sessionId) => seen.push(sessionId));

    client.write('quiet-session', 'a little typing\n');
    client.reconciled();

    expect(seen, 'a session that lost nothing hears nothing').toEqual([]);
  });
});
