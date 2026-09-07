import type { SessionState } from '@tabterm/shared';

/**
 * Explicit transition table. Anything not listed is illegal and rejected with a logged error
 * rather than silently allowed. See docs/04-session-lifecycle.md.
 */
const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  starting: ['attached', 'detached', 'exited'],
  attached: ['attached', 'detached', 'exited'],
  detached: ['attached', 'expiring', 'exited'],
  /**
   * `detached` is the reprieve, and it was missing.
   *
   * A reap timer means "look again", never "act on what I decided half an hour ago", so a
   * session about to be reaped whose reason has gone away goes back to simply being detached.
   * That transition was not in this table, so the reprieve threw: the timer was already deleted
   * by then, and the session was left in `expiring` with nothing left to move it, neither reaped
   * nor kept. The daemon logs an uncaught exception and carries on, which is why it presented as
   * a session in a state nobody could account for rather than as a crash.
   *
   * The case is a laptop waking up. Every overdue timer fires at once, before Chrome has said
   * which tabs it has, and the tabs then come back.
   */
  expiring: ['attached', 'detached', 'reaped', 'exited'],
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
