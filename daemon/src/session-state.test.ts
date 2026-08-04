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
