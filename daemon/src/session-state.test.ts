import { describe, expect, it } from 'vitest';
import type { SessionState } from '@tabterm/shared';
import { assertTransition, canTransition } from './session-state.js';

const ALL: SessionState[] = ['starting', 'attached', 'detached', 'expiring', 'exited', 'reaped'];

describe('session state machine', () => {
  it('never reaches an undefined state for any event sequence', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(typeof canTransition(from, to)).toBe('boolean');
      }
    }
  });

  it('allows the lifecycle a real session follows', () => {
    expect(canTransition('starting', 'attached')).toBe(true);
    expect(canTransition('attached', 'detached')).toBe(true);
    expect(canTransition('detached', 'expiring')).toBe(true);
    expect(canTransition('expiring', 'reaped')).toBe(true);
  });

  it('allows reattach to cancel expiry', () => {
    expect(canTransition('expiring', 'attached')).toBe(true);
    expect(canTransition('detached', 'attached')).toBe(true);
  });

  it('allows a reprieve, which is expiry cancelled by nobody arriving', () => {
    /**
     * A reap timer means "look again", not "act on what I decided half an hour ago". A session
     * about to be reaped whose reason has gone away goes back to being detached, and no client
     * has to turn up for that to be true. The case is a laptop waking: every overdue timer fires
     * at once, before Chrome has said which tabs it has, and then the tabs come back.
     *
     * Without this the reprieve threw. The timer had already been dropped by then, so the
     * session was left in `expiring` with nothing left to move it, neither reaped nor kept.
     */
    expect(canTransition('expiring', 'detached')).toBe(true);
  });

  it('never resurrects a reaped session', () => {
    for (const to of ALL) expect(canTransition('reaped', to)).toBe(false);
  });

  it('never goes straight from starting to reaped', () => {
    expect(canTransition('starting', 'reaped')).toBe(false);
  });

  it('lets a child exit from any live state', () => {
    for (const from of ['starting', 'attached', 'detached', 'expiring'] as SessionState[]) {
      expect(canTransition(from, 'exited')).toBe(true);
    }
  });

  it('rejects illegal transitions loudly', () => {
    expect(() => assertTransition('reaped', 'attached')).toThrowError(/illegal/);
    expect(() => assertTransition('exited', 'attached')).toThrowError(/illegal/);
  });
});
