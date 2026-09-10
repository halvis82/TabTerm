import { describe, expect, it } from 'vitest';
import { PtyHostClient } from './client.js';
import { initLog } from '../log.js';

/**
 * Who a reply belongs to when the request it answers has already been given up on.
 *
 * Replies are matched by the id the host echoes back. A host older than that echoes nothing, so
 * there is a fallback that hands the reply to the oldest waiter expecting that type, which is what
 * the single-slot map used to do and is right for that host.
 *
 * It was also firing for a reply that did carry an id, when no one was waiting on it any more. That
 * is a late answer to a request that timed out, and giving it to somebody else answers a different
 * session's question: a `replayed` for one session resolving another's request reports a gap filled
 * that was not.
 */
describe('a reply nobody is waiting for', () => {
  it('is dropped when it names a request that has gone', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    const matched = client.matchWaiter('replayed', 'a-request-that-timed-out', [
      { key: 'someone-else', expect: 'replayed' },
    ]);
    expect(matched).toBe('');
  });

  it('still reaches the oldest waiter when the host echoes no id at all', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    const matched = client.matchWaiter('replayed', '', [
      { key: 'oldest', expect: 'replayed' },
      { key: 'newer', expect: 'replayed' },
    ]);
    expect(matched).toBe('oldest');
  });

  it('prefers the id it was given over anything else', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    const matched = client.matchWaiter('replayed', 'mine', [
      { key: 'oldest', expect: 'replayed' },
      { key: 'mine', expect: 'replayed' },
    ]);
    expect(matched).toBe('mine');
  });

  it('never answers a question of a different kind', () => {
    initLog('error');
    const client = new PtyHostClient({ socketPath: '/nowhere', hostScript: '/nowhere' });
    const matched = client.matchWaiter('replayed', '', [{ key: 'other', expect: 'killed' }]);
    expect(matched).toBe('');
  });
});
