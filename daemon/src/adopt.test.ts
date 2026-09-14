import { describe, expect, it } from 'vitest';
import { adoptEverything, planAdoption, prunePanes } from './adopt.js';
import type { AdoptableSession, AdoptionDeps } from './adopt.js';
import { Database } from './database.js';
import type { LayoutNode } from '@tabterm/shared';

const pane = (sessionId: string): LayoutNode => ({
  type: 'terminal',
  paneId: `p-${sessionId}`,
  sessionId,
});
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [a, b],
});

describe('adopting a layout whose panes may not all have survived', () => {
  it('keeps a pane whose session is still running', () => {
    expect(prunePanes(pane('a'), new Set(['a']))).toEqual(pane('a'));
  });

  it('drops a pane whose session is gone', () => {
    // A pane that can never produce output is worse than an absent pane.
    expect(prunePanes(pane('a'), new Set())).toBe(null);
  });

  it('collapses a split when only one side survived', () => {
    const layout = split(pane('a'), pane('b'));
    expect(prunePanes(layout, new Set(['b']))).toEqual(pane('b'));
  });

  it('keeps both sides when both survived', () => {
    const layout = split(pane('a'), pane('b'));
    expect(prunePanes(layout, new Set(['a', 'b']))).toEqual(layout);
  });

  it('returns nothing when the whole workspace is gone', () => {
    expect(prunePanes(split(pane('a'), pane('b')), new Set())).toBe(null);
  });

  it('collapses nested splits down to what is left', () => {
    const layout = split(split(pane('a'), pane('b')), pane('c'));
    expect(prunePanes(layout, new Set(['b']))).toEqual(pane('b'));
  });
});

/**
 * The size a session was running at has to survive a daemon restart.
 *
 * The screen is rebuilt by replaying the host's output into a fresh emulator, and an emulator of
 * the wrong width wraps every line in the wrong place. Every restart used to rebuild every screen
 * at eighty columns while the terminals themselves carried on at whatever they really were, so a
 * reattaching tab was handed a folded-up copy of its own screen and a full-screen program had to
 * be resized before it looked right. The host had the true size the whole time.
 */
describe('what an adoption plan carries about size', () => {
  const db = new Database(':memory:');

  it('carries the size the host reports', () => {
    const plan = planAdoption(
      [{ sessionId: 's1', pid: 101, cwd: '/tmp', seq: 5, cols: 195, rows: 44 }],
      db,
      '/bin/zsh',
    );
    expect(plan.sessions[0]?.cols).toBe(195);
    expect(plan.sessions[0]?.rows).toBe(44);
  });

  it('says nothing rather than guessing when the host does not report one', () => {
    // An older host that does not send a size. Absent is honest; eighty by twenty-four is not,
    // and the caller can tell the difference and pick a default of its own.
    const plan = planAdoption([{ sessionId: 's2', pid: 102, cwd: '/tmp', seq: 0 }], db, '/bin/zsh');
    expect(plan.sessions[0]?.cols).toBeUndefined();
    expect(plan.sessions[0]?.rows).toBeUndefined();
  });
});

/**
 * And so does whether anybody had typed into it.
 *
 * The fact decides whether a tab may go back to the start screen, and it cannot be read from the
 * screen: a half-typed command sits on the prompt line and leaves the line count at one, exactly
 * like a prompt nobody has touched. The daemon knows it while it runs and forgets it on every
 * restart, which happens on every update. The host outlives the daemon and dies with the
 * terminals, so a fact kept there lasts exactly as long as the thing it is about.
 *
 * This plan is rebuilt field by field rather than spread, so anything not named is dropped. That
 * is how the size was lost before it was noticed.
 */
describe('what an adoption plan carries about use', () => {
  const db = new Database(':memory:');

  it('carries that somebody had typed into it', () => {
    const plan = planAdoption(
      [{ sessionId: 't1', pid: 201, cwd: '/tmp', seq: 1, hasInput: true }],
      db,
      '/bin/zsh',
    );
    expect(plan.sessions[0]?.hasInput).toBe(true);
  });

  it('carries the authorization to end it, which nothing else remembers', () => {
    // Closing a pane is the only thing that authorizes ending a session in no workspace, and a
    // session in no workspace is exactly what closing a pane produces.
    const plan = planAdoption(
      [{ sessionId: 't3', pid: 203, cwd: '/tmp', seq: 1, paneClosedByUser: true }],
      db,
      '/bin/zsh',
    );
    expect(plan.sessions[0]?.paneClosedByUser).toBe(true);
  });

  it('and says nothing when nobody has', () => {
    const plan = planAdoption([{ sessionId: 't2', pid: 202, cwd: '/tmp', seq: 1 }], db, '/bin/zsh');
    expect(plan.sessions[0]?.hasInput).toBeUndefined();
  });
});

/**
 * Saying that catching up is over, which is the thing a start with nothing to adopt never said.
 *
 * A connection to the host holds live output until the daemon says it has finished adopting and
 * replaying. That call sat inside the branch for "there is something to adopt", so a daemon that
 * found nothing never made it: every first start after a reboot, after a Reset, and every browser
 * run logged a warning five seconds later and held any output produced in between.
 *
 * Each of these fails against the call sitting inside the branch. See `adoptEverything`.
 */
describe('saying that catching up is over', () => {
  const db = new Database(':memory:');

  /** The four calls adoption makes, recorded rather than performed. */
  function spy(live: AdoptableSession[] | Error) {
    const calls = { reconciled: 0, adopted: [] as string[], replayed: [] as string[] };
    const deps: AdoptionDeps = {
      adoptable: () => (live instanceof Error ? Promise.reject(live) : Promise.resolve(live)),
      replay: (sessionId) => {
        calls.replayed.push(sessionId);
        return Promise.resolve();
      },
      adopt: (entry) => {
        calls.adopted.push(entry.sessionId);
        return { id: entry.sessionId };
      },
      hydrate: () => {},
      reconciled: () => {
        calls.reconciled += 1;
      },
    };
    return { deps, calls };
  }

  it('says it when there was nothing to adopt', async () => {
    const { deps, calls } = spy([]);
    await adoptEverything(deps, db, '/bin/zsh');
    expect(calls.reconciled).toBe(1);
  });

  it('says it when there was something to adopt', async () => {
    const { deps, calls } = spy([{ sessionId: 'a', pid: 1, cwd: '/tmp', seq: 0 }]);
    await adoptEverything(deps, db, '/bin/zsh');
    expect(calls.adopted).toEqual(['a']);
    expect(calls.replayed).toEqual(['a']);
    expect(calls.reconciled).toBe(1);
  });

  /**
   * The failing path matters most. Holding every terminal's output because a database row could
   * not be read is the failure this is an optimization over, arriving by another door.
   */
  it('says it even when asking the host threw', async () => {
    const { deps, calls } = spy(new Error('host went away'));
    await adoptEverything(deps, db, '/bin/zsh');
    expect(calls.adopted).toEqual([]);
    expect(calls.reconciled).toBe(1);
  });

  it('says it after the replays, never before', async () => {
    const order: string[] = [];
    const deps: AdoptionDeps = {
      adoptable: () => Promise.resolve([{ sessionId: 'a', pid: 1, cwd: '/tmp', seq: 0 }]),
      replay: (sessionId) => {
        order.push(`replay:${sessionId}`);
        return Promise.resolve();
      },
      adopt: (entry) => {
        order.push(`adopt:${entry.sessionId}`);
        return { id: entry.sessionId };
      },
      hydrate: () => {},
      reconciled: () => order.push('reconciled'),
    };
    await adoptEverything(deps, db, '/bin/zsh');
    expect(order).toEqual(['adopt:a', 'replay:a', 'reconciled']);
  });
});
