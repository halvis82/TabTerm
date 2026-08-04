import type { SessionState } from '@tabterm/shared';

/**
 * Explicit transition table. Anything not listed is illegal and rejected with a logged error
 * rather than silently allowed. See docs/04-session-lifecycle.md.
 */
const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  starting: ['attached', 'detached', 'exited'],
  attached: ['attached', 'detached', 'exited'],
  detached: ['attached', 'expiring', 'exited'],
  expiring: ['attached', 'reaped', 'exited'],
  exited: ['reaped'],
  reaped: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal session transition ${from} -> ${to}`);
  }
}

export const TERMINAL_STATES: readonly SessionState[] = ['exited', 'reaped'];
