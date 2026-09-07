import { describe, expect, it } from 'vitest';
import { decideReconnect } from './host-reconnect.js';

/**
 * What a reconnect to the PTY host is allowed to conclude.
 *
 * This is the single most destructive decision the daemon makes, and it had no check of any kind.
 * The behavior it replaces ended every session on every reconnect, which is correct only when the
 * host is a new process. The socket is reconnected after any close, including ones the host
 * survives, so that reasoning turned one transient socket error into the loss of every terminal
 * on the machine.
 */
describe('what is really gone when the host connection comes back', () => {
  const held = ['a', 'b', 'c'];

  it('keeps everything when the same host still has everything', () => {
    // A socket that dropped and came back. Nothing died. This is the case that was destroying
    // every terminal on the machine.
    expect(decideReconnect(held, ['a', 'b', 'c'])).toEqual({ lost: [], kept: ['a', 'b', 'c'] });
  });

  it('lets go of everything when a new host has nothing', () => {
    // The host was killed and restarted. Those processes died with it and cannot be recovered,
    // so the tabs get the expiry page, which is true, rather than a terminal that never answers.
    expect(decideReconnect(held, [])).toEqual({ lost: ['a', 'b', 'c'], kept: [] });
  });

  it('splits them when the host kept some and lost others', () => {
    expect(decideReconnect(held, ['b'])).toEqual({ lost: ['a', 'c'], kept: ['b'] });
  });

  it('keeps everything when the host cannot be asked', () => {
    // Deliberately the unsafe-looking answer, because the two mistakes are not equal. Ending a
    // session cannot be undone. Keeping one costs a terminal that answers nothing until the next
    // reconnect, which is seconds away.
    expect(decideReconnect(held, null)).toEqual({ lost: [], kept: ['a', 'b', 'c'] });
  });

  it('says nothing about sessions the host has and the daemon does not', () => {
    // Adoption is a different question, asked elsewhere and at a different time.
    expect(decideReconnect(['a'], ['a', 'z'])).toEqual({ lost: [], kept: ['a'] });
  });

  it('holds nothing, loses nothing', () => {
    expect(decideReconnect([], [])).toEqual({ lost: [], kept: [] });
    expect(decideReconnect([], null)).toEqual({ lost: [], kept: [] });
  });
});
